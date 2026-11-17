import { test } from "node:test";
import assert from "node:assert/strict";
import { Azure, RequestGate } from "../server/azure.js";
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { account, credentials, machine, testConfig } from "./fixtures.js";

const root = `/subscriptions/${account.subscriptionId}/resourceGroups/${machine.resourceGroup}`;
const resource = (type: string, name: string) => ({ id: `${root}/providers/${type}/${name}`, name, type });
const initial = [
  resource("Microsoft.Compute/virtualMachines", machine.name),
  resource("Microsoft.Compute/disks", `${machine.name}_OsDisk_1_test`),
  ...["ip", "ip6"].map((suffix) => resource("Microsoft.Network/publicIPAddresses", `${machine.name}-${suffix}`)),
  resource("Microsoft.Network/networkInterfaces", `${machine.name}-nic`),
  resource("Microsoft.Network/networkSecurityGroups", `${machine.name}-nsg`),
  resource("Microsoft.Network/virtualNetworks", `${machine.name}-vnet`),
];
function mock() {
  const state = { inventory: [...initial], managed: true, externalDisk: false, sharedDisk: false, sharedNsg: false, peering: false, reads: 0, changeAfter: Infinity, failDelete: false };
  const calls: { method: string; url: URL }[] = [];
  const azure = new Azure(new RequestGate(0), async (input, options) => {
    const url = new URL(String(input));
    calls.push({ method: options!.method!, url });
    if (options?.method === "DELETE") return state.failDelete
      ? Response.json({ error: { code: "ScopeLocked" } }, { status: 409 })
      : new Response(null, { status: 204 });
    if (url.pathname === root) return Response.json({ tags: state.managed ? { managedBy: "azpanel" } : {} });
    if (url.pathname === machine.resourceId) return Response.json({
      tags: { managedBy: "azpanel" },
      properties: {
        storageProfile: { osDisk: { name: initial[1].name, managedDisk: { id: state.externalDisk ? initial[1].id.replace(machine.resourceGroup, "shared") : initial[1].id } } },
        networkProfile: { networkInterfaces: [{ id: initial[4].id }] },
      },
    });
    if (url.pathname === `${root}/resources`) {
      state.reads++;
      return Response.json({ value: [...state.inventory, ...(state.reads > state.changeAfter ? [resource("Microsoft.Storage/storageAccounts", "unrelated")] : [])] });
    }
    if (url.pathname === initial[1].id) return Response.json({ properties: { maxShares: state.sharedDisk ? 2 : 1 } });
    if (url.pathname === initial[5].id) return Response.json({ properties: {
      networkInterfaces: state.sharedNsg ? [{ id: `${root}-other/providers/Microsoft.Network/networkInterfaces/shared-nic` }] : [],
    } });
    if (url.pathname === initial[6].id) return Response.json({ properties: {
      virtualNetworkPeerings: state.peering ? [{ name: "shared-peering" }] : [],
    } });
    if (url.pathname === "/subscriptions") return Response.json({ value: account.subscriptions });
    return Response.json({ value: [] });
  }, async () => "token");
  return { azure, state, calls };
}

test("VM cleanup preview includes IPv4/IPv6, disks and network; only reviewed inventory can be deleted", async () => {
  const { azure, calls, state } = mock();
  const preview = await azure.previewVmDeletion(credentials, account, machine);
  assert.equal(preview.cleanupAvailable, true);
  assert.deepEqual(preview.group!.resources.map((item) => item.id).sort(), initial.map((item) => item.id).sort());
  assert.ok(calls.every((call) => call.method === "GET"));
  await azure.deleteVmAndResources(credentials, account, machine, preview.group!.fingerprint, () => {}, true);
  const deletes = calls.filter((call) => call.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url.pathname, root);
  assert.equal(deletes[0].url.searchParams.get("forceDeletionTypes"), "Microsoft.Compute/virtualMachines");
  state.inventory.push(resource("Microsoft.Compute/disks", "other-data"));
  await assert.rejects(azure.deleteVmAndResources(credentials, account, machine, preview.group!.fingerprint, () => {}), /无法确认归属/);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("VM cleanup refuses non-dedicated, untagged, shared and incomplete resource groups without any writes", async () => {
  const { azure, calls, state } = mock();
  assert.equal((await azure.previewVmDeletion(credentials, account, { ...machine, resourceGroup: "shared" })).cleanupAvailable, false);
  assert.equal(calls.length, 0);
  state.managed = false;
  assert.equal((await azure.previewVmDeletion(credentials, account, machine)).cleanupAvailable, false);
  state.managed = true;
  state.externalDisk = true;
  assert.match((await azure.previewVmDeletion(credentials, account, machine)).reason!, /其他资源组/);
  state.externalDisk = false;
  state.sharedDisk = true;
  assert.match((await azure.previewVmDeletion(credentials, account, machine)).reason!, /磁盘.*共享/);
  state.sharedDisk = false;
  state.sharedNsg = true;
  assert.match((await azure.previewVmDeletion(credentials, account, machine)).reason!, /安全组.*共享/);
  state.sharedNsg = false;
  state.peering = true;
  assert.match((await azure.previewVmDeletion(credentials, account, machine)).reason!, /对等连接/);
  state.peering = false;
  state.inventory.push(resource("Microsoft.Compute/virtualMachines", "other-vm"));
  assert.match((await azure.previewVmDeletion(credentials, account, machine)).reason!, /other-vm/);
  state.inventory = [{ ...initial[0], id: "" }];
  await assert.rejects(azure.previewVmDeletion(credentials, account, machine), /清单不完整/);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("normal cleanup never escalates to force and locked group failures do not report success", async () => {
  const { azure, state, calls } = mock();
  const preview = await azure.previewVmDeletion(credentials, account, machine);
  state.failDelete = true;
  await assert.rejects(
    azure.deleteVmAndResources(credentials, account, machine, preview.group!.fingerprint, () => {}),
    /ScopeLocked/,
  );
  const deletes = calls.filter((call) => call.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url.searchParams.has("forceDeletionTypes"), false);
});

test("VM cleanup API enforces ownership, explicit destructive confirmation and clears only the deleted group cache", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true);
  const { azure, state, calls } = mock();
  const { app, tasks } = await buildApp(config, { store, azure });
  try {
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: config.adminEmail, password: config.adminPassword } });
    const owner = login.json().user.id;
    const headers = { cookie: "azpanel_session=" + login.cookies[0].value, "x-csrf-token": login.json().csrf };
    store.saveAccount(owner, account, credentials);
    store.replaceMachines(account.id, [{ vm: machine, raw: {} }, { vm: { ...machine, id: "other", resourceGroup: "unrelated" }, raw: {} }]);
    const url = `/api/machines/${machine.id}`;
    const preview = (await app.inject({ url: `${url}/delete-preview`, headers })).json();
    const payload = { action: "delete", confirmation: machine.name, cleanup: true, cleanupConfirmed: true, fingerprint: preview.group.fingerprint };
    for (const invalid of [
      { ...payload, confirmation: "wrong" },
      { ...payload, cleanupConfirmed: false },
      { ...payload, fingerprint: undefined },
      { ...payload, action: "restart" },
    ]) assert.equal((await app.inject({ method: "POST", url: `${url}/action`, headers, payload: invalid })).statusCode, 422);
    assert.equal(store.tasks(owner).length, 0);
    state.changeAfter = state.reads;
    const changed = await app.inject({ method: "POST", url: `${url}/action`, headers, payload });
    assert.equal(changed.statusCode, 409);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
    state.changeAfter = Infinity;
    // Submission is checked once; a change before the queued operation must also stop deletion.
    state.changeAfter = state.reads + 1;
    const queued = await app.inject({ method: "POST", url: `${url}/action`, headers, payload });
    await tasks.idle();
    assert.equal(store.task(owner, queued.json().taskId)?.status, "failed");
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
    assert.equal(store.machines(owner).length, 0, "failure refreshes the actual mock cloud snapshot");
    store.replaceMachines(account.id, [{ vm: machine, raw: {} }, { vm: { ...machine, id: "other", resourceGroup: "unrelated" }, raw: {} }]);
    state.changeAfter = Infinity;
    const other = store.createUser("vm-cleanup-other@example.test", "OtherPassword-1234");
    const otherLogin = await app.inject({ method: "POST", url: "/api/login", payload: { email: other.email, password: "OtherPassword-1234" } });
    const otherHeaders = { cookie: "azpanel_session=" + otherLogin.cookies[0].value, "x-csrf-token": otherLogin.json().csrf };
    const before = calls.length;
    assert.equal((await app.inject({ url: `${url}/delete-preview`, headers: otherHeaders })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `${url}/action`, headers: otherHeaders, payload })).statusCode, 404);
    assert.equal(calls.length, before);
    const result = await app.inject({ method: "POST", url: `${url}/action`, headers, payload: { ...payload, force: true } });
    assert.equal(result.statusCode, 200, result.body);
    await tasks.idle();
    assert.equal(store.task(owner, result.json().taskId)?.status, "succeeded");
    assert.match(store.task(owner, result.json().taskId)!.progress, /公网 IP.*已清理/);
    assert.deepEqual(store.machines(owner).map((vm) => vm.id), ["other"]);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  } finally { await app.close(); }
});

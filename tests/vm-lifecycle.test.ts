import { test } from "node:test";
import assert from "node:assert/strict";
import { Azure, RequestGate } from "../server/azure.js";
import { buildApp } from "../server/app.js";
import { AppError, Store } from "../server/store.js";
import { createVmSchema } from "../shared/validation.js";
import { account, credentials, machine, providerMetadata, testConfig } from "./fixtures.js";

const input = createVmSchema.parse({
  name: "test-vm", confirmation: "test-vm", location: "taiwannorth", size: "Standard_B1s",
  image: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "24.04.1" },
  diskSize: 30, username: "azureuser", authentication: "password", password: "TestOnly!Password123",
});

test("a physical Taiwan region without managed disks is excluded and rejected before any deployment write", async () => {
  const requests: { url: URL; method: string }[] = [];
  let disksEnabled = false;
  const azure = new Azure(new RequestGate(0), async (url, options) => {
    const value = new URL(String(url));
    requests.push({ url: value, method: options!.method! });
    if (value.pathname.endsWith("/locations")) return Response.json({ value: [
      { name: "taiwannorth", displayName: "Taiwan North", metadata: { regionType: "Physical" } },
      { name: "eastasia", displayName: "East Asia", metadata: { regionType: "Physical" } },
    ] });
    if (value.pathname.endsWith("/providers/Microsoft.Compute") || value.pathname.endsWith("/providers/Microsoft.Network")) {
      const provider = providerMetadata(value.pathname.split("/").pop()!, ["East Asia", "Taiwan North"]);
      if (provider.namespace === "Microsoft.Compute" && !disksEnabled)
        provider.resourceTypes.find((item) => item.resourceType === "disks")!.locations = ["East Asia"];
      return Response.json(provider);
    }
    if (value.pathname.endsWith("/skus")) return Response.json({ value: [{ resourceType: "virtualMachines", name: "Standard_B1s", capabilities: [{ name: "HyperVGenerations", value: "V2" }] }] });
    if (value.pathname.includes("/versions/")) return Response.json({ properties: { hyperVGeneration: "V2", osDiskImage: { sizeInGb: 30 } } });
    return Response.json({ value: [] });
  }, async () => "token");
  assert.deepEqual((await azure.vmLocations(credentials, account)).map((item) => item.name), ["eastasia"]);
  // A crafted API request still cannot bypass the UI's region filter.
  await assert.rejects(azure.create(credentials, account, input, () => {}), /taiwannorth.*Microsoft\.Compute\/disks.*未创建资源组/);
  assert.ok(requests.every((request) => request.method === "GET"));
  disksEnabled = true;
  assert.equal((await azure.vmLocations(credentials, account)).length, 1, "cached regions are reused");
  assert.equal((await azure.vmLocations(credentials, account, true)).length, 2, "explicit refresh bypasses cache");
  assert.ok(requests.some((request) => request.url.searchParams.get("api-version") === "2024-07-01"));
});

test("failed and incomplete VMs sync with unknown runtime state; permission failures still reject", async () => {
  let status = 404;
  const azure = new Azure(new RequestGate(0), async (url) => {
    const value = new URL(String(url));
    if (value.pathname.endsWith("/virtualMachines")) return Response.json({ value: [{
      id: machine.resourceId, name: machine.name, location: "taiwannorth",
      properties: { provisioningState: "Failed", networkProfile: { networkInterfaces: [{ id: "/missing-nic" }] } },
    }] });
    return Response.json({ error: { code: "ResourceNotFound" } }, { status });
  }, async () => "token");
  const [{ vm }] = await azure.machines(credentials, account);
  assert.equal(vm.provisioningState, "Failed");
  assert.equal(vm.powerState, "unknown");
  assert.equal(vm.diskSize, 0);
  assert.equal(vm.os, "Unknown");
  assert.deepEqual(vm.publicIps, []);
  status = 403;
  await assert.rejects(azure.machines(credentials, account), /权限不足/);
});

test("deletion waits through a failed resource state until 404, and force is always explicit", async () => {
  const calls: { method: string; url: URL }[] = [];
  const azure = new Azure(new RequestGate(0), async (url, options) => {
    calls.push({ method: options!.method!, url: new URL(String(url)) });
    if (calls.length === 1) return Response.json({ properties: { provisioningState: "Failed" } }, { status: 202, headers: { "Retry-After": "0" } });
    if (calls.length === 2) return Response.json({ properties: { provisioningState: "Failed" } }, { headers: { "Retry-After": "0" } });
    return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 });
  }, async () => "token");
  await azure.deleteVm(credentials, machine, () => {}, true);
  assert.deepEqual(calls.map((call) => call.method), ["DELETE", "GET", "GET"]);
  assert.equal(calls[0].url.searchParams.get("forceDeletion"), "true");
  assert.ok(calls.slice(1).every((call) => !call.url.searchParams.has("forceDeletion")));
  calls.length = 0;
  const absent = new Azure(new RequestGate(0), async (url, options) => {
    calls.push({ method: options!.method!, url: new URL(String(url)) });
    return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 });
  }, async () => "token");
  await absent.deleteVm(credentials, machine, () => {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.has("forceDeletion"), false);
});

test("a missing deletion operation-status URL is not treated as successful resource deletion", async () => {
  let calls = 0;
  const azure = new Azure(new RequestGate(0), async () => ++calls === 1
    ? Response.json({}, { status: 202, headers: { Location: "/operation/missing", "Retry-After": "0" } })
    : Response.json({ error: { code: "NotFound" } }, { status: 404 }), async () => "token");
  await assert.rejects(azure.deleteVm(credentials, machine, () => {}), /NotFound/);
});

test("nested deployment error codes provide useful hints without leaking echoed secrets", async () => {
  const secret = "VmSecret-NotForLogs";
  const azure = new Azure(new RequestGate(0), async () => Response.json({ error: {
    code: "DeploymentFailed", message: secret,
    details: [{ code: "LocationNotAvailableForResourceType", message: secret }],
  } }, { status: 400 }), async () => "token");
  await assert.rejects(azure.operation(credentials, "PUT", "/deployment", { password: secret }),
    (error) => error instanceof Error && /LocationNotAvailableForResourceType.*目标区域/.test(error.message) && !error.message.includes(secret));
});

test("an explicitly forced deletion clears cache and stays successful even when unrelated sync fails", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true);
  const deletes: URL[] = [];
  const azure = new Azure(new RequestGate(0), async (url, options) => {
    if (options!.method === "DELETE") {
      deletes.push(new URL(String(url)));
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: { code: "AuthorizationFailed" } }, { status: 403 });
  }, async () => "token");
  const { app, tasks } = await buildApp(config, { store, azure });
  try {
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: config.adminEmail, password: config.adminPassword } });
    const owner = login.json().user.id;
    const headers = { cookie: "azpanel_session=" + login.cookies[0].value, "x-csrf-token": login.json().csrf };
    store.saveAccount(owner, account, credentials);
    store.replaceMachines(account.id, [{ vm: machine, raw: {} }]);
    const url = `/api/machines/${machine.id}/action`;
    for (const payload of [
      { action: "delete", force: true, confirmation: "wrong" },
      { action: "restart", force: true, confirmation: machine.name },
    ]) assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 422);
    assert.equal(deletes.length, 0);
    const result = await app.inject({ method: "POST", url, headers, payload: { action: "delete", force: true, confirmation: machine.name } });
    assert.equal(result.statusCode, 200, result.body);
    await tasks.idle();
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].searchParams.get("forceDeletion"), "true");
    assert.equal(store.machines(owner).length, 0);
    const task = store.task(owner, result.json().taskId)!;
    assert.equal(task.kind, "强制删除虚拟机");
    assert.equal(task.status, "succeeded");
    assert.match(task.progress, /已删除.*其余资源同步失败/);
  } finally { await app.close(); }
});

test("failed creation syncs partial resources for cleanup and preserves the original deployment error", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true);
  const azure = new Azure(new RequestGate(0));
  azure.create = async () => { throw new AppError(502, "Azure [LocationNotAvailableForResourceType]"); };
  azure.subscriptions = async () => account.subscriptions;
  azure.machines = async () => [{ vm: { ...machine, provisioningState: "Failed" }, raw: {} }];
  const { app, tasks } = await buildApp(config, { store, azure });
  try {
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: config.adminEmail, password: config.adminPassword } });
    const owner = login.json().user.id;
    const headers = { cookie: "azpanel_session=" + login.cookies[0].value, "x-csrf-token": login.json().csrf };
    store.saveAccount(owner, account, credentials);
    const result = await app.inject({ method: "POST", url: `/api/accounts/${account.id}/machines`, headers, payload: input });
    await tasks.idle();
    const task = store.task(owner, result.json().taskId)!;
    assert.equal(task.status, "failed");
    assert.match(task.error!, /LocationNotAvailableForResourceType/);
    assert.equal(store.machines(owner)[0].provisioningState, "Failed");
  } finally { await app.close(); }
});

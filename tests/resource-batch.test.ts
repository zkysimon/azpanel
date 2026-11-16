import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { Azure, RequestGate } from "../server/azure.js";
import { account, credentials, machine, testConfig } from "./fixtures.js";

test("group deletion previews full inventories, requires confirmation, and refuses changed inventories", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true);
  const requests: string[] = [];
  let changed = false;
  let queuedChanged = false;
  let unreadable = false;
  const checks = new Map<string, number>();
  const azure = new Azure(new RequestGate(0), async (input, options) => {
    const url = new URL(String(input));
    requests.push(`${options?.method} ${url.pathname}`);
    if (options?.method === "DELETE") return new Response(null, { status: 204 });
    const group = url.pathname.split("/")[4];
    checks.set(group, (checks.get(group) ?? 0) + 1);
    if (group === "unreadable" && unreadable)
      return Response.json({ error: { code: "AuthorizationFailed" } }, { status: 403 });
    const disk = (name: string) => ({ id: `/subscriptions/${account.subscriptionId}/resourceGroups/${group}/providers/Microsoft.Compute/disks/${name}`, name, type: "Microsoft.Compute/disks" });
    if (group === "occupied") {
      if (url.searchParams.has("page")) return Response.json({ value: [disk("second-disk")] });
      return Response.json({ value: [disk("os-disk")], nextLink: `${url.pathname}?page=2` });
    }
    if (group === "changed" && changed) return Response.json({ value: [disk("new-disk")] });
    if (group === "queued" && queuedChanged && checks.get(group)! >= 3)
      return Response.json({ value: [disk("late-disk")] });
    return Response.json({ value: [] });
  }, async () => "token");
  const { app, tasks } = await buildApp(config, { store, azure });
  try {
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: config.adminEmail, password: config.adminPassword } });
    const owner = login.json().user.id;
    const headers = { cookie: "azpanel_session=" + login.cookies[0].value, "x-csrf-token": login.json().csrf };
    store.saveAccount(owner, account, credentials);
    store.replaceMachines(account.id, [{ vm: { ...machine, resourceGroup: "occupied" }, raw: {} }]);
    const previewUrl = `/api/accounts/${account.id}/groups/delete-preview`;
    const deleteUrl = `/api/accounts/${account.id}/groups`;
    const preview = await app.inject({ method: "POST", url: previewUrl, headers, payload: { groups: ["occupied", "empty", "changed", "queued", "unreadable"] } });
    assert.equal(preview.statusCode, 200, preview.body);
    const previews = preview.json();
    assert.deepEqual(previews[0].resources.map((item: any) => item.name), ["os-disk", "second-disk"]);
    assert.equal(requests.filter((item) => item.startsWith("DELETE")).length, 0);
    assert.equal(store.tasks(owner).length, 0);
    const occupied = previews[0];
    for (const payload of [
      { group: "occupied", confirmation: "occupied" },
      { group: "occupied", fingerprint: occupied.fingerprint, confirmation: "wrong" },
    ]) {
      assert.equal((await app.inject({ method: "DELETE", url: deleteUrl, headers, payload })).statusCode, 422);
    }
    changed = true;
    queuedChanged = true;
    unreadable = true;
    const result = await app.inject({ method: "POST", url: `${deleteUrl}/delete-batch`, headers, payload: {
      groups: previews.map(({ group, fingerprint }: any) => ({ group, fingerprint })), confirmation: "DELETE",
    } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().results.filter((item: any) => item.status === "failed").length, 2);
    await tasks.idle();
    const task = store.tasks(owner)[0];
    assert.equal(task.status, "failed");
    assert.deepEqual((await app.inject({ url: `/api/tasks/${task.id}`, headers })).json().results, task.results);
    assert.deepEqual(task.results?.filter((item) => item.status === "succeeded").map((item) => item.name), ["occupied", "empty"]);
    assert.match(task.results?.find((item) => item.name === "queued")?.message ?? "", /已变化/);
    assert.equal(requests.filter((item) => item.startsWith("DELETE")).length, 2);
    assert.equal(store.machines(owner).length, 0);
    const staleSingle = await app.inject({ method: "DELETE", url: deleteUrl, headers,
      payload: { ...previews[2], confirmation: "changed" } });
    assert.equal(staleSingle.statusCode, 409);
    assert.match(staleSingle.json().error, /已变化/);
    const duplicate = await app.inject({ method: "POST", url: `${deleteUrl}/delete-batch`, headers,
      payload: { groups: [previews[1], { ...previews[1], group: "EMPTY" }], confirmation: "DELETE" } });
    assert.equal(duplicate.statusCode, 422);
    const other = store.createUser("other-batch@example.test", "Other-password123");
    const otherLogin = await app.inject({ method: "POST", url: "/api/login", payload: { email: other.email, password: "Other-password123" } });
    const otherHeaders = { cookie: "azpanel_session=" + otherLogin.cookies[0].value, "x-csrf-token": otherLogin.json().csrf };
    const before = requests.length;
    for (const url of [previewUrl, `${deleteUrl}/delete-batch`])
      assert.equal((await app.inject({ method: "POST", url, headers: otherHeaders,
        payload: { groups: [previews[1]], confirmation: "DELETE" } })).statusCode, 404);
    assert.equal(requests.length, before);
    assert.deepEqual((await app.inject({ url: "/api/tasks", headers: otherHeaders })).json(), []);
    // A single occupied group is accepted only with the reviewed inventory and exact name.
    const single = await app.inject({ method: "DELETE", url: deleteUrl, headers,
      payload: { group: "occupied", fingerprint: occupied.fingerprint, confirmation: "occupied" } });
    assert.equal(single.statusCode, 200, single.body);
    await tasks.idle();
    assert.equal(store.task(owner, single.json().taskId)?.status, "succeeded");
  } finally { await app.close(); }
});

test("an incomplete resource inventory can never authorize deletion", async () => {
  const azure = new Azure(new RequestGate(0), async () => Response.json({ value: [{ name: "disk", type: "Microsoft.Compute/disks" }] }), async () => "token");
  await assert.rejects(azure.previewGroupDeletion(credentials, account, "test"), /清单不完整/);
});

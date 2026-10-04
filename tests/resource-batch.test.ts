import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { Azure, RequestGate } from "../server/azure.js";
import { account, credentials, testConfig } from "./fixtures.js";

test("batch deletion rejects non-empty groups early, rechecks emptiness and records per-item results", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true),
    requests: string[] = [],
    checks = new Map<string, number>();
  const azure = new Azure(
    new RequestGate(0),
    async (input, options) => {
      const url = new URL(String(input));
      requests.push(`${options?.method} ${url.pathname}`);
      const group = url.pathname.split("/")[4];
      if (options?.method === "DELETE")
        return new Response(null, { status: 204 });
      const count = (checks.get(group) ?? 0) + 1;
      checks.set(group, count);
      if (group === "occupied" || (group === "changed" && count > 1))
        return Response.json({
          value: [{ name: "os-disk", type: "Microsoft.Compute/disks" }],
          nextLink: "https://management.azure.com/do-not-fetch",
        });
      if (group === "forbidden")
        return Response.json(
          { error: { code: "AuthorizationFailed" } },
          { status: 403 },
        );
      return Response.json({ value: [] });
    },
    async () => "token",
  );
  const { app, tasks } = await buildApp(config, { store, azure });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: config.adminEmail, password: config.adminPassword },
    });
    const owner = login.json().user.id;
    const headers = {
      cookie: "azpanel_session=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrf,
    };
    store.saveAccount(owner, account, credentials);
    const single = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${account.id}/groups`,
      headers,
      payload: { group: "occupied", confirmation: "occupied" },
    });
    assert.equal(single.statusCode, 409);
    assert.match(single.json().error, /os-disk/);
    assert.equal(store.tasks(owner).length, 0);
    assert.equal(requests.length, 1);
    const result = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/groups/delete-batch`,
      headers,
      payload: {
        groups: ["occupied", "empty", "changed", "forbidden"],
        confirmation: "DELETE",
      },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(
      result
        .json()
        .results.filter((item: { status: string }) => item.status === "failed")
        .length,
      2,
    );
    await tasks.idle();
    const task = store.tasks(owner)[0];
    assert.equal(task.status, "failed");
    assert.equal(
      task.results?.filter((item) => item.status === "succeeded").length,
      1,
    );
    assert.ok(
      task.results
        ?.find((item) => item.name === "changed")
        ?.message?.includes("非空"),
    );
    assert.equal(
      requests.filter((request) => request.startsWith("DELETE")).length,
      1,
    );
    assert.ok(
      requests
        .find((request) => request.startsWith("DELETE"))
        ?.endsWith("/resourceGroups/empty"),
    );
    assert.ok(requests.every((request) => !request.includes("do-not-fetch")));
    const onlyOccupied = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/groups/delete-batch`,
      headers,
      payload: { groups: ["occupied"], confirmation: "DELETE" },
    });
    assert.equal(onlyOccupied.json().taskId, null);
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/groups/delete-batch`,
      headers,
      payload: { groups: ["empty", "EMPTY"], confirmation: "DELETE" },
    });
    assert.equal(duplicate.statusCode, 422);
    const other = store.createUser(
      "other-batch@example.test",
      "Other-password123",
    );
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: other.email, password: "Other-password123" },
    });
    const otherHeaders = {
      cookie: "azpanel_session=" + otherLogin.cookies[0].value,
      "x-csrf-token": otherLogin.json().csrf,
    };
    const before = requests.length;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/groups/delete-batch`,
          headers: otherHeaders,
          payload: { groups: ["empty"], confirmation: "DELETE" },
        })
      ).statusCode,
      404,
    );
    assert.equal(requests.length, before);
    assert.deepEqual(
      (await app.inject({ url: "/api/tasks", headers: otherHeaders })).json(),
      [],
    );
  } finally {
    await app.close();
  }
});

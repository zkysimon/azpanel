import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { Azure, RequestGate } from "../server/azure.js";
import { account, credentials, machine, testConfig } from "./fixtures.js";

test("session, CSRF, tenant isolation, read-only gate, credential encryption, and persistent task lifecycle", async () => {
  let cloudCalls = 0;
  const store = new Store(testConfig, true);
  const azure = new Azure(
    new RequestGate(0),
    async () => {
      cloudCalls++;
      throw new Error("No cloud calls expected");
    },
    async () => "token",
  );
  const { app, tasks } = await buildApp(testConfig, { store, azure });
  try {
    assert.equal((await app.inject("/api/accounts")).statusCode, 401);
    assert.equal((await app.inject("/api%2Faccounts")).statusCode >= 400, true);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: {
        email: testConfig.adminEmail,
        password: testConfig.adminPassword,
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    const session = login.json();
    const cookie = login.cookies[0].name + "=" + login.cookies[0].value;
    const headers = { cookie, "x-csrf-token": session.csrf };
    assert.ok(login.headers["set-cookie"]?.toString().includes("HttpOnly"));
    store.saveAccount(session.user.id, account, credentials);
    store.replaceMachines(account.id, [{ vm: machine, raw: {} }]);
    assert.ok(
      !JSON.stringify(
        store.db.prepare("SELECT * FROM accounts").get(),
      ).includes(credentials.password),
    );
    const list = await app.inject({ url: "/api/accounts", headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json()[0].label, account.label);
    assert.ok(!list.body.includes(credentials.password));
    const rejectedCsrf = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${account.id}`,
      headers: { cookie },
      payload: { confirmation: account.label },
    });
    assert.equal(rejectedCsrf.statusCode, 403);
    const write = await app.inject({
      method: "POST",
      url: `/api/machines/${machine.id}/action`,
      headers,
      payload: { action: "restart", confirmation: machine.name },
    });
    assert.equal(write.statusCode, 403);
    assert.equal(cloudCalls, 0);
    const other = store.createUser("other@example.test", "OtherPassword-1234");
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: other.email, password: "OtherPassword-1234" },
    });
    const otherHeaders = {
      cookie: "azpanel_session=" + otherLogin.cookies[0].value,
      "x-csrf-token": otherLogin.json().csrf,
    };
    const metrics = await app.inject({
      url: `/api/machines/${machine.id}/metrics`,
      headers: otherHeaders,
    });
    assert.equal(metrics.statusCode, 404);
    assert.deepEqual(
      (
        await app.inject({ url: "/api/accounts", headers: otherHeaders })
      ).json(),
      [],
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/machines/${machine.id}`,
          headers: otherHeaders,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/sync`,
          headers: otherHeaders,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: "/api/users", headers: otherHeaders }))
        .statusCode,
      403,
    );
    assert.equal(cloudCalls, 0);
    const taskId = tasks.enqueue(
      session.user.id,
      account.id,
      "test",
      account.label,
      async (progress) => {
        progress("mock work");
      },
    );
    assert.throws(
      () =>
        tasks.enqueue(
          session.user.id,
          account.id,
          "duplicate",
          account.label,
          async () => {},
        ),
      /已有任务/,
    );
    await tasks.idle();
    assert.equal(
      store.tasks(session.user.id).find((task) => task.id === taskId)?.status,
      "succeeded",
    );
    await app.inject({ method: "POST", url: "/api/logout", headers });
    assert.equal(
      (await app.inject({ url: "/api/accounts", headers })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test("resource deletion verifies confirmation and never deletes the containing resource group", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true);
  const requests: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (url, options) => {
      requests.push(options!.method + " " + String(url));
      if (options!.method === "DELETE")
        return new Response(null, { status: 204 });
      if (String(url).includes("/subscriptions?"))
        return Response.json({ value: account.subscriptions });
      return Response.json({ value: [] });
    },
    async () => "token",
  );
  const { app, tasks } = await buildApp(config, { store, azure });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: {
        email: testConfig.adminEmail,
        password: testConfig.adminPassword,
      },
    });
    const session = login.json(),
      headers = {
        cookie: "azpanel_session=" + login.cookies[0].value,
        "x-csrf-token": session.csrf,
      };
    store.saveAccount(session.user.id, account, credentials);
    store.replaceMachines(account.id, [{ vm: machine, raw: {} }]);
    const url = `/api/machines/${machine.id}/action`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { action: "delete", confirmation: "wrong" },
        })
      ).statusCode,
      422,
    );
    assert.equal(requests.length, 0);
    const result = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { action: "delete", confirmation: machine.name },
    });
    assert.equal(result.statusCode, 200, result.body);
    await tasks.idle();
    const deletes = requests.filter((request) => request.startsWith("DELETE"));
    assert.equal(deletes.length, 1);
    assert.ok(deletes[0].includes("/virtualMachines/dev-api-01?"));
    assert.equal(store.tasks(session.user.id)[0].status, "succeeded");
  } finally {
    await app.close();
  }
});

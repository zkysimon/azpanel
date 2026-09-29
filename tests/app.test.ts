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

test("presets save, encrypt, isolate per user, and keep a single default", async () => {
  const store = new Store(testConfig, true);
  const { app } = await buildApp(testConfig, {
    store,
    azure: new Azure(
      new RequestGate(0),
      async () => Response.json({ value: [] }),
      async () => "token",
    ),
  });
  const settings = {
    location: "eastasia",
    size: "Standard_B1s",
    image: {
      publisher: "Canonical",
      offer: "ubuntu-24_04-lts",
      sku: "server",
      version: "latest",
    },
    diskSize: 30,
    username: "azureuser",
    authentication: "password",
    sshKey: "",
    password: "Preset!Password123",
    allowedSource: "203.0.113.1/32",
    ipv6: false,
    customData: "",
  };
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: {
        email: testConfig.adminEmail,
        password: testConfig.adminPassword,
      },
    });
    const session = login.json();
    const headers = {
      cookie: "azpanel_session=" + login.cookies[0].value,
      "x-csrf-token": session.csrf,
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/presets",
      headers,
      payload: { name: "香港 B1s", isDefault: true, settings },
    });
    assert.equal(created.statusCode, 200, created.body);
    const preset = created.json();
    assert.equal(preset.settings.password, "Preset!Password123");
    // Stored encrypted at rest.
    const raw = store.db.prepare("SELECT data FROM presets").get() as {
      data: string;
    };
    assert.ok(!raw.data.includes("Preset!Password123"));
    const second = await app.inject({
      method: "POST",
      url: "/api/presets",
      headers,
      payload: { name: "东京 2C4G", isDefault: true, settings },
    });
    assert.equal(second.statusCode, 200);
    const list = (await app.inject({ url: "/api/presets", headers })).json();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, "东京 2C4G", "default must sort first");
    assert.equal(
      list.filter((item: { isDefault: boolean }) => item.isDefault).length,
      1,
      "only one default preset allowed",
    );
    const updated = await app.inject({
      method: "PUT",
      url: `/api/presets/${preset.id}`,
      headers,
      payload: { name: "香港 B1s 改名", isDefault: false, settings },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    // Another user cannot see or touch it.
    const other = store.createUser(
      "preset-other@example.test",
      "OtherPassword-1234",
    );
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: other.email, password: "OtherPassword-1234" },
    });
    const otherHeaders = {
      cookie: "azpanel_session=" + otherLogin.cookies[0].value,
      "x-csrf-token": otherLogin.json().csrf,
    };
    assert.deepEqual(
      (await app.inject({ url: "/api/presets", headers: otherHeaders })).json(),
      [],
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/presets/${preset.id}`,
          headers: otherHeaders,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/presets/${preset.id}`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/presets", headers })).json().length,
      1,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/presets",
          headers,
          payload: {
            name: "坏预设",
            settings: { ...settings, allowedSource: "999.1.1.1/99" },
          },
        })
      ).statusCode,
      422,
    );
  } finally {
    await app.close();
  }
});

test("invite registration enforces expiry, use limits, and admin control", async () => {
  const store = new Store(testConfig, true);
  const { app } = await buildApp(testConfig, {
    store,
    azure: new Azure(
      new RequestGate(0),
      async () => Response.json({ value: [] }),
      async () => "token",
    ),
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: {
        email: testConfig.adminEmail,
        password: testConfig.adminPassword,
      },
    });
    const headers = {
      cookie: "azpanel_session=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrf,
    };
    // Registration stays closed until an admin opens it.
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/register",
          payload: {
            email: "invited@example.test",
            password: "InvitedPass-1234",
            inviteCode: "AAAA-BBBB-CCCC-DDDD",
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/invites/registration",
          headers,
          payload: { open: true },
        })
      ).json().registrationOpen,
      true,
    );
    assert.equal(
      (await app.inject({ url: "/api/session" })).json().registrationOpen,
      true,
    );
    const limited = (
      await app.inject({
        method: "POST",
        url: "/api/invites",
        headers,
        payload: { note: "单次", maxUses: 1, expiresInDays: null },
      })
    ).json();
    assert.match(limited.code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    assert.equal(limited.expiresAt, null, "null days means permanent");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/register",
          payload: {
            email: "one@example.test",
            password: "InvitedPass-1234",
            inviteCode: limited.code,
          },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/register",
          payload: {
            email: "two@example.test",
            password: "InvitedPass-1234",
            inviteCode: limited.code,
          },
        })
      ).statusCode,
      422,
    );
    const expired = (
      await app.inject({
        method: "POST",
        url: "/api/invites",
        headers,
        payload: { note: "过期", maxUses: 0, expiresInDays: 1 },
      })
    ).json();
    store.db
      .prepare("UPDATE invites SET expires_at=? WHERE id=?")
      .run(Date.now() - 1000, expired.id);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/register",
          payload: {
            email: "late@example.test",
            password: "InvitedPass-1234",
            inviteCode: expired.code,
          },
        })
      ).statusCode,
      422,
    );
    const unlimited = (
      await app.inject({
        method: "POST",
        url: "/api/invites",
        headers,
        payload: { note: "无限", maxUses: 0, expiresInDays: null },
      })
    ).json();
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/register",
          payload: {
            email: "one@example.test",
            password: "InvitedPass-1234",
            inviteCode: unlimited.code,
          },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/register",
          payload: {
            email: "three@example.test",
            password: "short",
            inviteCode: unlimited.code,
          },
        })
      ).statusCode,
      422,
    );
    const memberLogin = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: "one@example.test", password: "InvitedPass-1234" },
    });
    const memberHeaders = {
      cookie: "azpanel_session=" + memberLogin.cookies[0].value,
      "x-csrf-token": memberLogin.json().csrf,
    };
    assert.equal(
      (await app.inject({ url: "/api/invites", headers: memberHeaders }))
        .statusCode,
      403,
    );
    const list = (await app.inject({ url: "/api/invites", headers })).json();
    assert.equal(list.registrationOpen, true);
    assert.equal(list.invites.length, 3);
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/invites/${unlimited.id}`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/invites", headers })).json().invites
        .length,
      2,
    );
  } finally {
    await app.close();
  }
});

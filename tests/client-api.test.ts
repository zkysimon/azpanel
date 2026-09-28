import { test } from "node:test";
import assert from "node:assert/strict";
import { api, setCsrf } from "../client/api.js";
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { Azure, RequestGate } from "../server/azure.js";
import type { Session } from "../shared/types.js";
import { account, credentials, testConfig } from "./fixtures.js";

test("browser API helper supports bodyless sync and logout over HTTP", async () => {
  const store = new Store(testConfig, true);
  const azure = new Azure(
    new RequestGate(0),
    async (url) =>
      Response.json({
        value: String(url).includes("/subscriptions?")
          ? account.subscriptions
          : [],
      }),
    async () => "test-token",
  );
  const { app, tasks } = await buildApp(testConfig, { store, azure });
  const nativeFetch = globalThis.fetch;
  const requests: { path: string; headers: Headers; body: unknown }[] = [];
  let cookie = "";
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    // Only resolve relative URLs and supply browser-style cookies. All request
    // serialization and response parsing go through the real client helper.
    globalThis.fetch = async (input, options) => {
      const headers = new Headers(options?.headers);
      requests.push({ path: String(input), headers, body: options?.body });
      if (cookie) headers.set("Cookie", cookie);
      const response = await nativeFetch(new URL(String(input), base), {
        ...options,
        headers,
      });
      const sessionCookie = response.headers.get("set-cookie");
      if (sessionCookie) cookie = sessionCookie.split(";")[0];
      return response;
    };

    const session = await api<Session>("/login", "POST", {
      email: testConfig.adminEmail,
      password: testConfig.adminPassword,
    });
    assert.ok(session.user);
    setCsrf(session.csrf);
    store.saveAccount(session.user.id, account, credentials);

    const result = await api<{ taskId: string }>(
      `/accounts/${account.id}/sync`,
      "POST",
    );
    await tasks.idle();
    assert.equal(
      store.tasks(session.user.id).find((task) => task.id === result.taskId)
        ?.status,
      "succeeded",
    );
    const synced = await api<(typeof account)[]>("/accounts");
    assert.ok(synced[0].lastSync! > account.lastSync!);
    assert.deepEqual(await api("/logout", "POST"), { ok: true });
    assert.equal((await api<Session>("/session")).user, null);

    assert.equal(requests[0].headers.get("Content-Type"), "application/json");
    for (const request of requests.slice(1)) {
      assert.equal(request.headers.has("Content-Type"), false, request.path);
      assert.equal(request.body, undefined, request.path);
      assert.equal(request.headers.get("X-CSRF-Token"), session.csrf);
    }
  } finally {
    globalThis.fetch = nativeFetch;
    setCsrf("");
    await app.close();
  }
});

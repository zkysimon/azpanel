import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCache } from "../server/ai-cache.js";
import { Azure, RequestGate } from "../server/azure.js";
import { AzureAi } from "../server/azure-ai.js";
import { Store } from "../server/store.js";
import { account, credentials, testConfig } from "./fixtures.js";

test("AI snapshots survive a process restart, expire, isolate credentials and cascade on account removal", async () => {
  const dataDir = mkdtempSync(
    join(
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Temp", "opencode")
        : tmpdir(),
      "azpanel-ai-",
    ),
  );
  const config = { ...testConfig, dataDir };
  let store = new Store(config);
  let calls = 0;
  const createAzure = () =>
    new Azure(
      new RequestGate(0),
      async () => {
        calls++;
        return Response.json({
          value: [
            {
              id: `/subscriptions/${account.subscriptionId}/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/test-ai`,
              name: "test-ai",
              kind: "OpenAI",
              location: "eastus",
            },
          ],
        });
      },
      async () => "token",
    );
  try {
    const owner = store.db.prepare("SELECT id FROM users LIMIT 1").get() as {
      id: string;
    };
    store.saveAccount(owner.id, account, credentials);
    const first = await new AzureAi(createAzure(), store).services(
      credentials,
      account,
    );
    assert.equal(calls, 1);
    store.close();
    store = new Store(config);
    assert.deepEqual(
      await new AzureAi(createAzure(), store).services(credentials, account),
      first,
    );
    assert.equal(calls, 1, "restart should read SQLite, not Azure");
    assert.ok(
      !JSON.stringify(
        store.db.prepare("SELECT * FROM ai_cache").all(),
      ).includes(credentials.password),
    );

    await new AzureAi(createAzure(), store).services(
      { ...credentials, password: "rotated-secret" },
      account,
    );
    assert.equal(
      calls,
      2,
      "a new credential identity must not reuse the old snapshot",
    );
    store.db.prepare("UPDATE ai_cache SET expires_at=0").run();
    await new AzureAi(createAzure(), store).services(credentials, account);
    assert.equal(calls, 3, "expired snapshots must be refetched");
    await new AzureAi(createAzure(), store).services(
      credentials,
      account,
      true,
    );
    assert.equal(calls, 4, "explicit refresh must bypass persistent snapshots");
    store.db.prepare("DELETE FROM accounts WHERE id=?").run(account.id);
    assert.equal(store.db.prepare("SELECT * FROM ai_cache").all().length, 0);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("AI cache coalesces refreshes and prevents a late read from restoring invalidated data", async () => {
  const cache = new AiCache();
  let completeOld!: (value: string[]) => void;
  const old = cache.read(
    "account",
    "models",
    60_000,
    () =>
      new Promise<string[]>((resolve) => {
        completeOld = resolve;
      }),
  );
  await Promise.resolve();
  let loads = 0;
  const load = async () => {
    loads++;
    return ["new"];
  };
  assert.deepEqual(
    await Promise.all([
      cache.read("account", "models", 60_000, load, true),
      cache.read("account", "models", 60_000, load, true),
      cache.read("account", "models", 60_000, load),
    ]),
    [["new"], ["new"], ["new"]],
  );
  assert.equal(loads, 1);
  completeOld(["old"]);
  await old;
  assert.deepEqual(await cache.read("account", "models", 60_000, load), [
    "new",
  ]);
  assert.equal(loads, 1);

  cache.invalidate("models");
  await assert.rejects(
    cache.read("account", "models", 60_000, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.deepEqual(await cache.read("account", "models", 60_000, load), [
    "new",
  ]);
  assert.equal(loads, 2, "failed loads must remain retryable");
});

test("a removed account cannot be recreated by an in-flight cache write", async () => {
  const store = new Store(testConfig, true);
  try {
    const owner = store.db.prepare("SELECT id FROM users LIMIT 1").get() as {
      id: string;
    };
    store.saveAccount(owner.id, account, credentials);
    const cache = new AiCache(store);
    let complete!: (value: string[]) => void;
    const pending = cache.read(
      account.id,
      "models",
      60_000,
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    await Promise.resolve();
    store.db.prepare("DELETE FROM accounts WHERE id=?").run(account.id);
    complete(["model"]);
    await pending;
    assert.equal(store.db.prepare("SELECT * FROM ai_cache").all().length, 0);
  } finally {
    store.close();
  }
});

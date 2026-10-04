import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { account, credentials, machine, testConfig } from "./fixtures.js";

test("database restart retains encrypted accounts, marks jobs interrupted, and rolls back partial snapshots", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "azpanel-test-"));
  const config = { ...testConfig, dataDir };
  let store = new Store(config);
  try {
    const user = store.db.prepare("SELECT id FROM users LIMIT 1").get() as {
      id: string;
    };
    store.saveAccount(user.id, account, credentials);
    store.replaceMachines(account.id, [{ vm: machine, raw: {} }]);
    assert.throws(() =>
      store.replaceMachines(account.id, [
        { vm: machine, raw: {} },
        { vm: machine, raw: {} },
      ]),
    );
    assert.equal(store.machines(user.id).length, 1);
    store.db
      .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "interrupted-task",
        user.id,
        account.id,
        "create",
        machine.name,
        "running",
        "waiting",
        null,
        Date.now(),
        Date.now(),
      );
    store.db
      .prepare("INSERT INTO task_results VALUES(?,?)")
      .run(
        "interrupted-task",
        JSON.stringify([{ name: "empty-group", status: "succeeded" }]),
      );
    store.db
      .prepare("INSERT INTO billing_cache VALUES(?,?,?)")
      .run(
        account.id,
        JSON.stringify({ checkedAt: 123, credit: { remaining: null } }),
        Date.now() + 900000,
      );
    store.close();
    store = new Store(config);
    assert.deepEqual(store.credentials(user.id, account.id), credentials);
    assert.equal(store.tasks(user.id)[0].status, "interrupted");
    assert.equal(store.accounts(user.id).length, 1);
    assert.deepEqual(store.tasks(user.id)[0].results, [
      { name: "empty-group", status: "succeeded" },
    ]);
    assert.ok(
      store.db
        .prepare("SELECT data FROM billing_cache WHERE account_id=?")
        .get(account.id),
    );
    assert.equal(
      (
        store.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      5,
    );
    store.db.prepare("DELETE FROM accounts WHERE id=?").run(account.id);
    assert.equal(
      store.db
        .prepare("SELECT data FROM billing_cache WHERE account_id=?")
        .get(account.id),
      undefined,
    );
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

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
    store.close();
    store = new Store(config);
    assert.deepEqual(store.credentials(user.id, account.id), credentials);
    assert.equal(store.tasks(user.id)[0].status, "interrupted");
    assert.equal(store.accounts(user.id).length, 1);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

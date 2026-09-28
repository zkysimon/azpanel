import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Account,
  Credentials,
  Json,
  Task,
  User,
  VirtualMachine,
} from "../shared/types.js";
import { decrypt, encrypt, hashPassword } from "./security.js";
import type { Config } from "./config.js";

export class Store {
  db: DatabaseSync;
  constructor(
    readonly config: Config,
    memory = false,
  ) {
    if (!memory) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(
      memory ? ":memory:" : join(config.dataDir, "azpanel.sqlite"),
    );
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL, credentials TEXT NOT NULL, subscription_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(user_id, subscription_id, label));
      CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, data TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, kind TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, progress TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS accounts_owner ON accounts(user_id);
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id, created_at);
      CREATE INDEX IF NOT EXISTS audit_owner ON audit(user_id, created_at);
      PRAGMA user_version=1;`);
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted', progress='服务重启，请先刷新资源状态后再操作', updated_at=? WHERE status IN ('running','queued')",
      )
      .run(Date.now());
    this.db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .run(Date.now());
    if (!this.db.prepare("SELECT id FROM users LIMIT 1").get()) {
      if (!config.adminEmail || config.adminPassword.length < 12)
        throw new Error(
          "首次启动需设置 ADMIN_EMAIL 和至少 12 位的 ADMIN_PASSWORD",
        );
      this.createUser(config.adminEmail, config.adminPassword, "admin");
    }
  }
  createUser(
    email: string,
    password: string,
    role: User["role"] = "user",
  ): User {
    const user = { id: randomUUID(), email: email.toLowerCase(), role };
    this.db
      .prepare("INSERT INTO users VALUES(?,?,?,?,?)")
      .run(user.id, user.email, hashPassword(password), role, Date.now());
    return user;
  }
  accounts(userId: string): Account[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM accounts WHERE user_id=? ORDER BY rowid DESC",
        )
        .all(userId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  account(userId: string, id: string): Account {
    const row = this.db
      .prepare("SELECT data FROM accounts WHERE id=? AND user_id=?")
      .get(id, userId) as { data: string } | undefined;
    if (!row) throw new AppError(404, "账户不存在");
    return JSON.parse(row.data);
  }
  credentials(userId: string, id: string): Credentials {
    const row = this.db
      .prepare("SELECT credentials FROM accounts WHERE id=? AND user_id=?")
      .get(id, userId) as { credentials: string } | undefined;
    if (!row) throw new AppError(404, "账户不存在");
    return decrypt(row.credentials, this.config.encryptionKey);
  }
  saveAccount(userId: string, account: Account, credentials?: Credentials) {
    if (credentials) {
      this.db
        .prepare(
          `INSERT INTO accounts(id,user_id,label,credentials,subscription_id,data) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET label=excluded.label, credentials=excluded.credentials, subscription_id=excluded.subscription_id, data=excluded.data WHERE accounts.user_id=excluded.user_id`,
        )
        .run(
          account.id,
          userId,
          account.label,
          encrypt(credentials, this.config.encryptionKey),
          account.subscriptionId,
          JSON.stringify(account),
        );
    } else
      this.db
        .prepare("UPDATE accounts SET label=?, data=? WHERE id=? AND user_id=?")
        .run(account.label, JSON.stringify(account), account.id, userId);
  }
  machines(userId: string): VirtualMachine[] {
    return (
      this.db
        .prepare(
          "SELECT m.data FROM machines m JOIN accounts a ON a.id=m.account_id WHERE a.user_id=? ORDER BY m.rowid DESC",
        )
        .all(userId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  machine(userId: string, id: string): { vm: VirtualMachine; raw: Json } {
    const row = this.db
      .prepare(
        "SELECT m.data,m.raw FROM machines m JOIN accounts a ON a.id=m.account_id WHERE a.user_id=? AND m.id=?",
      )
      .get(userId, id) as { data: string; raw: string } | undefined;
    if (!row) throw new AppError(404, "虚拟机不存在，请同步账户");
    return { vm: JSON.parse(row.data), raw: JSON.parse(row.raw) };
  }
  replaceMachines(
    accountId: string,
    machines: { vm: VirtualMachine; raw: Json }[],
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM machines WHERE account_id=?").run(accountId);
      for (const { vm, raw } of machines)
        this.db
          .prepare("INSERT INTO machines VALUES(?,?,?,?)")
          .run(vm.id, accountId, JSON.stringify(vm), JSON.stringify(raw));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  tasks(userId: string): Task[] {
    return this.db
      .prepare(
        "SELECT id,account_id AS accountId,kind,target,status,progress,error,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(userId) as unknown as Task[];
  }
  audit(userId: string, action: string, target: string) {
    this.db
      .prepare(
        "INSERT INTO audit(user_id,action,target,created_at) VALUES(?,?,?,?)",
      )
      .run(userId, action, target, Date.now());
  }
  close() {
    this.db.close();
  }
}
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

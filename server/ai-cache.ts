import type { Store } from "./store.js";

interface Snapshot {
  value: unknown;
  expiresAt: number;
}
interface Pending {
  promise: Promise<unknown>;
  fresh: boolean;
}

/** Account-scoped snapshots, with single-flight reads and optional persistence. */
export class AiCache {
  private values = new Map<string, Snapshot>();
  private pending = new Map<string, Pending>();
  constructor(private store?: Store) {}

  invalidate(key: string) {
    this.values.delete(key);
    this.pending.delete(key);
    this.store?.db.prepare("DELETE FROM ai_cache WHERE key=?").run(key);
  }

  private remember(key: string, snapshot: Snapshot) {
    this.values.delete(key);
    this.values.set(key, snapshot);
    if (this.values.size > 500) {
      for (const [key, value] of this.values)
        if (value.expiresAt <= Date.now()) this.values.delete(key);
      while (this.values.size > 500)
        this.values.delete(this.values.keys().next().value!);
    }
  }

  prime(accountId: string, key: string, value: unknown, ttl: number) {
    this.pending.delete(key);
    const snapshot = { value, expiresAt: Date.now() + ttl };
    this.remember(key, snapshot);
    if (this.store) {
      this.store.db
        .prepare("DELETE FROM ai_cache WHERE expires_at<=?")
        .run(Date.now());
      // A read may finish after an account was removed. Never recreate it.
      this.store.db
        .prepare(
          "INSERT OR REPLACE INTO ai_cache(key,account_id,data,expires_at) SELECT ?,id,?,? FROM accounts WHERE id=?",
        )
        .run(key, JSON.stringify(value), snapshot.expiresAt, accountId);
    }
  }

  async read<T>(
    accountId: string,
    key: string,
    ttl: number,
    load: () => Promise<T>,
    fresh = false,
    onLoaded?: (value: T) => void,
  ): Promise<T> {
    // Concurrent explicit refreshes share one new read. Invalidation detaches
    // older reads so their late results cannot overwrite a newer snapshot.
    if (fresh && !this.pending.get(key)?.fresh) this.invalidate(key);
    if (!fresh) {
      let snapshot = this.values.get(key);
      if (!snapshot || snapshot.expiresAt <= Date.now()) {
        const row = this.store?.db
          .prepare(
            "SELECT data,expires_at FROM ai_cache WHERE key=? AND account_id=? AND expires_at>?",
          )
          .get(key, accountId, Date.now()) as
          { data: string; expires_at: number } | undefined;
        if (row) {
          snapshot = { value: JSON.parse(row.data), expiresAt: row.expires_at };
          this.remember(key, snapshot);
        }
      }
      if (snapshot && snapshot.expiresAt > Date.now())
        return snapshot.value as T;
    }
    const existing = this.pending.get(key);
    if (existing) return existing.promise as Promise<T>;
    const entry: Pending = {
      fresh,
      promise: Promise.resolve()
        .then(load)
        .then((value) => {
          if (this.pending.get(key) === entry) {
            onLoaded?.(value);
            this.prime(accountId, key, value, ttl);
          }
          return value;
        })
        .finally(() => {
          if (this.pending.get(key) === entry) this.pending.delete(key);
        }),
    };
    this.pending.set(key, entry);
    return entry.promise as Promise<T>;
  }
}

import { randomUUID } from "node:crypto";
import { AppError, Store } from "./store.js";
import type { TaskItemResult } from "../shared/types.js";

export class Tasks {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(readonly store: Store) {}
  enqueue(
    userId: string,
    accountId: string,
    kind: string,
    target: string,
    work: (
      progress: (message: string) => void,
    ) => Promise<void | TaskItemResult[]>,
  ) {
    if (this.pending >= 20)
      throw new AppError(429, "后台任务队列已满，请稍后再试");
    const active = this.store.db
      .prepare(
        "SELECT id FROM tasks WHERE account_id=? AND status IN ('queued','running')",
      )
      .get(accountId);
    if (active) throw new AppError(409, "该账户已有任务正在执行，请等待完成");
    const id = randomUUID(),
      now = Date.now();
    this.store.db
      .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        userId,
        accountId,
        kind,
        target,
        "queued",
        "等待执行",
        null,
        now,
        now,
      );
    this.store.audit(userId, kind, target);
    this.pending++;
    const progress = (message: string) =>
      this.store.db
        .prepare("UPDATE tasks SET progress=?, updated_at=? WHERE id=?")
        .run(message, Date.now(), id);
    this.tail = this.tail.then(async () => {
      this.store.db
        .prepare("UPDATE tasks SET status='running', updated_at=? WHERE id=?")
        .run(Date.now(), id);
      try {
        const results = await work(progress);
        if (results) {
          this.store.db
            .prepare(
              "INSERT OR REPLACE INTO task_results(task_id,data) VALUES(?,?)",
            )
            .run(id, JSON.stringify(results));
          const failed = results.filter((result) => result.status === "failed");
          if (failed.length)
            throw new AppError(
              502,
              `${results.length - failed.length} 项成功，${failed.length} 项失败，请查看逐项结果`,
            );
        }
        this.store.db
          .prepare(
            "UPDATE tasks SET status='succeeded', progress='已完成', updated_at=? WHERE id=?",
          )
          .run(Date.now(), id);
      } catch (error) {
        const message =
          error instanceof AppError
            ? error.message
            : "任务失败，请检查本地配置或刷新云资源状态";
        this.store.db
          .prepare(
            "UPDATE tasks SET status='failed', progress='执行失败', error=?, updated_at=? WHERE id=?",
          )
          .run(message, Date.now(), id);
      } finally {
        this.pending--;
      }
    });
    return id;
  }
  async idle() {
    await this.tail;
  }
}

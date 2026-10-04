import { Alert, LinearProgress } from "@mui/material";
import type { Task } from "../shared/types.js";
import type { InlineJob } from "./useInlineTask.js";

export default function InlineTask({
  job,
  task,
  error,
}: {
  job: InlineJob | null;
  task: Task | null;
  error: string;
}) {
  if (!job) return null;
  const running = !task || ["queued", "running"].includes(task.status);
  return (
    <section aria-label="当前操作进度" className="inline-task">
      <Alert
        severity={
          running ? "info" : task.status === "succeeded" ? "success" : "error"
        }
      >
        <strong>
          {job.kind} · {job.target}
        </strong>
        <div>{task?.error || task?.progress || "请求已接受，等待任务执行"}</div>
        {error && (
          <div>进度暂不可读：{error}。正在重试查询，请勿重复提交。</div>
        )}
      </Alert>
      {running && <LinearProgress />}
    </section>
  );
}

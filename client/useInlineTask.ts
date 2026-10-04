import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import type { Task } from "../shared/types.js";

export interface InlineJob {
  id: string;
  accountId: string;
  target: string;
  kind: string;
  context?: string;
}
export function useInlineTask(onSettled: (task: Task, job: InlineJob) => void) {
  const [job, setJob] = useState<InlineJob | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => {
    if (!job) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<Task>(`/tasks/${job!.id}`);
        if (!active) return;
        setTask(next);
        setError("");
        if (!["queued", "running"].includes(next.status)) {
          settled.current(next, job!);
          return;
        }
      } catch (error) {
        if (active) setError((error as Error).message);
      }
      if (active) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [job]);
  function start(next: InlineJob) {
    setTask(null);
    setError("");
    setJob(next);
  }
  return {
    job,
    task,
    error,
    start,
    running: !!job && (!task || ["queued", "running"].includes(task.status)),
  };
}

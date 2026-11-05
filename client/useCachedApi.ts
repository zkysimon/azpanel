import { useCallback, useEffect, useRef, useState } from "react";
import { apiSnapshot, cachedApi } from "./api.js";

/** Render a snapshot immediately; revalidate expired data without blanking it. */
export function useCachedApi<T>(path: string | null, ttl: number) {
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    loading: boolean;
    error: string;
  }>({ path: null, loading: false, error: "" });
  const sequence = useRef(0);
  const load = useCallback(
    async (fresh = false) => {
      const id = ++sequence.current;
      if (!path) {
        setState({ path, loading: false, error: "" });
        return;
      }
      const snapshot = apiSnapshot<T>(path);
      setState((previous) => ({
        path,
        data:
          snapshot?.value ??
          (previous.path === path ? previous.data : undefined),
        loading: fresh || !snapshot || snapshot.expiresAt <= Date.now(),
        error: "",
      }));
      try {
        const data = await cachedApi<T>(path, ttl, fresh);
        if (id === sequence.current)
          setState({ path, data, loading: false, error: "" });
      } catch (error) {
        if (id === sequence.current)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: (error as Error).message,
          }));
      }
    },
    [path, ttl],
  );
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const current =
    state.path === path
      ? state
      : { data: apiSnapshot<T>(path)?.value, loading: !!path, error: "" };
  return { ...current, reload: load };
}

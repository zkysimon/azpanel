let csrf = "";
const reads = new Map<string, Promise<unknown>>();
const snapshots = new Map<
  string,
  { value: unknown; expiresAt: number; storedAt: number }
>();
const cacheLoads = new Map<
  string,
  { promise: Promise<unknown>; fresh: boolean }
>();

export function invalidateApiCache(prefix = "/") {
  for (const map of [reads, snapshots, cacheLoads])
    for (const path of map.keys())
      if (path.startsWith(prefix)) map.delete(path);
}

export const setCsrf = (value: string) => {
  if (csrf !== value) invalidateApiCache();
  csrf = value;
};

export function apiSnapshot<T>(path: string | null) {
  const snapshot = path ? snapshots.get(path) : undefined;
  if (!snapshot) return undefined;
  // Bound how long an old snapshot can be displayed during revalidation.
  if (Date.now() - snapshot.storedAt >= 24 * 60 * 60_000) {
    snapshots.delete(path!);
    return undefined;
  }
  return { ...snapshot, value: snapshot.value as T };
}

export function cachedApi<T>(
  path: string,
  ttl: number,
  fresh = false,
): Promise<T> {
  if (fresh && !cacheLoads.get(path)?.fresh) invalidateApiCache(path);
  const snapshot = apiSnapshot<T>(path);
  if (!fresh && snapshot && snapshot.expiresAt > Date.now())
    return Promise.resolve(snapshot.value);
  const pending = cacheLoads.get(path);
  if (pending) return pending.promise as Promise<T>;
  const entry = {
    fresh,
    promise: api<T>(
      path + (fresh ? `${path.includes("?") ? "&" : "?"}refresh=true` : ""),
    )
      .then((value) => {
        if (cacheLoads.get(path) === entry) {
          snapshots.delete(path);
          snapshots.set(path, {
            value,
            expiresAt: Date.now() + ttl,
            storedAt: Date.now(),
          });
          while (snapshots.size > 100)
            snapshots.delete(snapshots.keys().next().value!);
        }
        return value;
      })
      .finally(() => {
        if (cacheLoads.get(path) === entry) cacheLoads.delete(path);
      }),
  };
  cacheLoads.set(path, entry);
  return entry.promise;
}

// Share simultaneous GETs (including React remounts), but never cache mutations
// or session responses. Snapshot caching is explicitly opted into with cachedApi.
export function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (method !== "GET") {
    const aiWrite = path.match(
      /^(\/accounts\/[^/]+\/ai)\/(services|deployments)$/,
    );
    const prefixes = !aiWrite
      ? ["/"]
      : aiWrite[2] === "services"
        ? [`${aiWrite[1]}/services`]
        : [`${aiWrite[1]}/deployments`, `${aiWrite[1]}/usages`];
    const invalidate = () => prefixes.forEach(invalidateApiCache);
    invalidate();
    return request<T>(path, method, body).finally(invalidate);
  }
  const pending = reads.get(path);
  if (pending) return pending as Promise<T>;
  const promise = request<T>(path, method, body).finally(() => {
    if (reads.get(path) === promise) reads.delete(path);
  });
  reads.set(path, promise);
  return promise;
}

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { "X-CSRF-Token": csrf };
  // Bodyless actions (sync/logout) must not advertise an empty JSON document.
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("服务器返回了无效响应，请检查连接后重试");
  }
  if (!response.ok) {
    if (response.status === 401) invalidateApiCache();
    throw new Error(value.error ?? "请求失败");
  }
  return value as T;
}

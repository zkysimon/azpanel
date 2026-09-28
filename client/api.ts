let csrf = "";
export const setCsrf = (value: string) => {
  csrf = value;
};
export async function api<T>(
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
  if (!response.ok) throw new Error(value.error ?? "请求失败");
  return value as T;
}

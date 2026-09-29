import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(".env.node")) process.loadEnvFile(".env.node");

export interface Config {
  encryptionKey: string;
  dataDir: string;
  host: string;
  port: number;
  adminEmail: string;
  adminPassword: string;
  writesEnabled: boolean;
  cookieSecure: boolean;
  azureInterval: number;
  /** "gravatar" loads avatars from gravatar.com; "local" renders initials offline. */
  avatarSource: "gravatar" | "local" | "none";
}
export function configuration(): Config {
  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey))
    throw new Error(
      "ENCRYPTION_KEY 必须是 64 位十六进制密钥，请配置 .env.node",
    );
  const avatarSource = process.env.AVATAR_SOURCE ?? "gravatar";
  return {
    encryptionKey,
    dataDir: resolve(process.env.DATA_DIR ?? "data"),
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
    adminEmail: process.env.ADMIN_EMAIL ?? "",
    adminPassword: process.env.ADMIN_PASSWORD ?? "",
    writesEnabled: process.env.AZURE_ALLOW_WRITES === "true",
    cookieSecure: process.env.COOKIE_SECURE === "true",
    azureInterval: Math.max(
      1000,
      Number(process.env.AZURE_REQUEST_INTERVAL_MS ?? 1500),
    ),
    avatarSource: ["gravatar", "local", "none"].includes(avatarSource)
      ? (avatarSource as Config["avatarSource"])
      : "gravatar",
  };
}

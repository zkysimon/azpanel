import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";

export function encrypt(value: unknown, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64"))
    .join(".");
}
export function decrypt<T>(value: string, key: string): T {
  const [iv, tag, data] = value
    .split(".")
    .map((part) => Buffer.from(part, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString(),
  );
}
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function verifyPassword(password: string, encoded: string): boolean {
  const [salt, hash] = encoded.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}
export const hashToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");

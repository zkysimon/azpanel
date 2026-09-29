import { createHash } from "node:crypto";

/**
 * Builds an avatar URL for an email address.
 *
 * The email is hashed with SHA-256 and only the hash is sent (Gravatar
 * convention), never the address itself. Set AVATAR_SOURCE=local to render
 * initials offline instead, or none to disable avatars entirely.
 */
export function avatarUrl(
  email: string,
  source: "gravatar" | "local" | "none",
): string | null {
  if (source !== "gravatar") return null;
  const hash = createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=96`;
}

/** Deterministic tint index (0-5) so offline initials avatars stay stable. */
export function avatarTint(email: string): number {
  const hash = createHash("sha256").update(email.trim().toLowerCase()).digest();
  return hash[0] % 6;
}

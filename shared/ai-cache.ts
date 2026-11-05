// Keep browser and server freshness windows aligned. Browser snapshots may be
// displayed while revalidating, but writes always validate against Azure again.
export const aiCacheTtl = {
  services: 5 * 60_000,
  service: 5 * 60_000,
  deployments: 60_000,
  models: 60 * 60_000,
  usages: 60_000,
} as const;

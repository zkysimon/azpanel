import type { Location } from "./types.js";

export const regionGroups = [
  "亚洲",
  "欧洲",
  "北美洲",
  "南美洲",
  "大洋洲",
  "非洲",
  "其他区域",
];
/** Azure's geographyGroup combines Asia and Oceania; geography disambiguates them. */
export function regionGroup(metadata: {
  geographyGroup?: string;
  geography?: string;
}): string {
  const group = (metadata.geographyGroup ?? "").toLowerCase();
  const geography = (metadata.geography ?? "").toLowerCase();
  if (/australia|new zealand|oceania/.test(geography + " " + group))
    return "大洋洲";
  if (/asia|middle east/.test(group)) return "亚洲";
  if (/europe/.test(group)) return "欧洲";
  if (
    /north america|us gov/.test(group) ||
    ["us", "usa", "canada", "mexico"].includes(group)
  )
    return "北美洲";
  if (/south america/.test(group)) return "南美洲";
  if (/africa/.test(group)) return "非洲";
  if (
    /japan|korea|india|china|singapore|hong kong|taiwan|malaysia|indonesia|israel|qatar|uae|saudi/.test(
      geography,
    )
  )
    return "亚洲";
  if (
    /united states|canada|mexico/.test(geography) ||
    ["us", "usa"].includes(geography)
  )
    return "北美洲";
  if (/brazil|chile/.test(geography)) return "南美洲";
  return "其他区域";
}
export function sortRegions(items: Location[]): Location[] {
  return [...items].sort(
    (a, b) =>
      regionGroups.indexOf(a.continent ?? "其他区域") -
        regionGroups.indexOf(b.continent ?? "其他区域") ||
      a.displayName.localeCompare(b.displayName, "en"),
  );
}

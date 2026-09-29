import { z } from "zod";

/** Images are discovered from Azure per region; these are only the offers we walk. */
export interface ImageRef {
  publisher: string;
  offer: string;
  sku: string;
  version: string;
}
export interface ImageOption extends ImageRef {
  label: string;
  family: string;
  osType: "Linux" | "Windows";
}

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const imageRefSchema = z.object({
  publisher: z.string().regex(segment, "无效的镜像 publisher"),
  offer: z.string().regex(segment, "无效的镜像 offer"),
  sku: z.string().regex(segment, "无效的镜像 sku"),
  version: z
    .string()
    .regex(/^(latest|[0-9][A-Za-z0-9._-]{0,63})$/, "无效的镜像版本"),
});
export type ImageRefInput = z.infer<typeof imageRefSchema>;
export const looksLikeWindows = (
  image: Pick<ImageRef, "publisher" | "offer" | "sku">,
) => /windows/i.test(`${image.publisher} ${image.offer} ${image.sku}`);

/** Curated publisher/offer pairs whose SKUs are listed live from Azure. */
export const imageTargets: {
  publisher: string;
  offer: string;
  family: string;
}[] = [
  {
    publisher: "Canonical",
    offer: "ubuntu-24_04-lts",
    family: "Ubuntu 24.04 LTS",
  },
  {
    publisher: "Canonical",
    offer: "0001-com-ubuntu-server-jammy",
    family: "Ubuntu 22.04 LTS",
  },
  {
    publisher: "Canonical",
    offer: "0001-com-ubuntu-server-focal",
    family: "Ubuntu 20.04 LTS",
  },
  { publisher: "Debian", offer: "debian-12", family: "Debian 12" },
  { publisher: "Debian", offer: "debian-11", family: "Debian 11" },
  { publisher: "almalinux", offer: "almalinux-x86_64", family: "AlmaLinux" },
  { publisher: "resf", offer: "rockylinux-x86_64", family: "Rocky Linux" },
  { publisher: "Oracle", offer: "oracle-linux", family: "Oracle Linux" },
  {
    publisher: "MicrosoftWindowsServer",
    offer: "WindowsServer",
    family: "Windows Server",
  },
];

/** Offline fallback so creation still works if the region listing is unavailable. */
export const fallbackImages: ImageOption[] = [
  {
    publisher: "Canonical",
    offer: "ubuntu-24_04-lts",
    sku: "server",
    version: "latest",
    label: "Ubuntu 24.04 LTS",
    family: "Ubuntu 24.04 LTS",
    osType: "Linux",
  },
  {
    publisher: "Canonical",
    offer: "0001-com-ubuntu-server-jammy",
    sku: "22_04-lts-gen2",
    version: "latest",
    label: "Ubuntu 22.04 LTS",
    family: "Ubuntu 22.04 LTS",
    osType: "Linux",
  },
  {
    publisher: "Debian",
    offer: "debian-12",
    sku: "12-gen2",
    version: "latest",
    label: "Debian 12",
    family: "Debian 12",
    osType: "Linux",
  },
  {
    publisher: "MicrosoftWindowsServer",
    offer: "WindowsServer",
    sku: "2022-datacenter-smalldisk-g2",
    version: "latest",
    label: "Windows Server 2022",
    family: "Windows Server",
    osType: "Windows",
  },
];

/**
 * Keep only SKUs that work with Gen2 x64 images. Preferred names are gen2/g2,
 * dropping gen1 and arm64; offers without a gen2 marker (e.g. Ubuntu 24.04
 * "server") keep their base SKUs.
 */
export function selectGen2Skus(skus: string[]): string[] {
  const named = skus.filter((sku) => /gen2|g2/i.test(sku));
  return (named.length ? named : skus).filter(
    (sku) => !/gen1|arm64/i.test(sku),
  );
}

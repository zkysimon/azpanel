import { ClientSecretCredential } from "@azure/identity";
import { createHash } from "node:crypto";
import type {
  Account,
  Credentials,
  GroupDeletionPreview,
  Json,
  MetricPoint,
  Quota,
  Sku,
  Subscription,
  VirtualMachine,
  VmDeletionPreview,
} from "../shared/types.js";
import type { CreateVm } from "../shared/validation.js";
import {
  imageTargets,
  looksLikeWindows,
  selectGen2Skus,
  type ImageOption,
  type ImageRef,
} from "../shared/images.js";
import { AppError } from "./store.js";
import { regionGroup, sortRegions } from "../shared/regions.js";

const ARM = "https://management.azure.com";
const compute = "2024-07-01";
const network = "2023-11-01";
const resources = "2021-04-01";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Transport = typeof fetch;
type TokenProvider = (credentials: Credentials) => Promise<string>;
const vmResourceTypes: Record<string, string[]> = {
  "Microsoft.Compute": ["virtualMachines", "disks"],
  "Microsoft.Network": [
    "networkSecurityGroups",
    "publicIPAddresses",
    "virtualNetworks",
    "networkInterfaces",
  ],
};
const normalizeLocation = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");
function unsupportedVmResources(region: string, providers: Json[]) {
  return Object.entries(vmResourceTypes).flatMap(([namespace, types], index) =>
    types
      .filter((type) => {
        const entry = providers[index].resourceTypes?.find(
          (entry: Json) =>
            entry.resourceType?.toLowerCase() === type.toLowerCase(),
        );
        return !entry?.locations?.some(
          (location: string) =>
            normalizeLocation(location) === normalizeLocation(region),
        );
      })
      .map((type) => `${namespace}/${type}`),
  );
}
/** Codes only: Azure can echo passwords/customData in template error messages. */
function azureFailure(error: Json, fallback = "OperationFailed") {
  const codes: string[] = [];
  function visit(value: Json, depth = 0) {
    const code = String(value.code ?? "")
      .replace(/[^a-zA-Z0-9_.-]/g, "")
      .slice(0, 100);
    if (code && !codes.includes(code)) codes.push(code);
    if (depth < 4 && codes.length < 12)
      for (const child of (value.details ?? []).slice(0, 12))
        visit(child, depth + 1);
  }
  visit(error);
  const hints: Record<string, string> = {
    InvalidResourceLocation:
      "目标区域不支持该资源，请更换区域或联系 Azure 支持确认订阅访问权限",
    LocationNotAvailableForResourceType:
      "目标区域不支持该资源，请更换区域或联系 Azure 支持确认订阅访问权限",
    ScopeLocked: "资源或上级范围存在锁，请先在 Azure Portal 检查锁",
    AuthorizationFailed: "权限不足，请检查服务主体 RBAC",
    SkuNotAvailable: "所选规格在目标区域不可用，请更换规格或区域",
    OperationNotAllowed:
      "Azure 不允许此操作，请检查配额及活动日志；失败 VM 可尝试明确确认后的强制删除",
  };
  const hint = codes.map((code) => hints[code]).find(Boolean);
  return `[${codes.join(" > ") || fallback}]${hint ? "：" + hint : ""}`;
}
export class AzureError extends AppError {
  constructor(
    readonly azureStatus: number,
    message: string,
  ) {
    super(502, message);
  }
}

/** One process-wide serial rate gate. Failed requests do not poison the queue. */
export class RequestGate {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  constructor(readonly interval = 1500) {}
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await sleep(Math.max(0, this.nextAt - Date.now()));
      try {
        return await work();
      } finally {
        this.nextAt = Date.now() + this.interval;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export function armUrl(path: string): URL {
  const url = new URL(path, ARM);
  if (url.origin !== ARM || url.username || url.password || url.hash)
    throw new AppError(400, "无效的 Azure API 地址");
  return url;
}
export const capabilities = (sku: Json): Record<string, string> =>
  Object.fromEntries(
    (sku.capabilities ?? []).map((item: Json) => [item.name, item.value]),
  );
export const powerState = (view: Json): string =>
  (view.statuses ?? [])
    .find((item: Json) => item.code?.startsWith("PowerState/"))
    ?.code?.slice(11) ?? "unknown";
export function selectSubscription(
  values: Subscription[],
  id?: string,
): Subscription {
  if (!values.length)
    throw new AppError(
      422,
      "身份验证成功，但没有可访问的订阅。请检查订阅状态及服务主体的 RBAC 权限。",
    );
  if (id) {
    const selected = values.find(
      (value) => value.subscriptionId.toLowerCase() === id.toLowerCase(),
    );
    if (!selected)
      throw new AppError(422, "无法访问指定订阅，请检查订阅 ID 和权限");
    return selected;
  }
  return values.find((value) => value.state === "Enabled") ?? values[0];
}

export class Azure {
  private identities = new Map<string, ClientSecretCredential>();
  private cache = new Map<string, { expires: number; value: unknown }>();
  private loading = new Map<string, Promise<unknown>>();
  private cacheEpoch = new Map<string, number>();
  constructor(
    readonly gate = new RequestGate(),
    private transport: Transport = fetch,
    private tokenProvider?: TokenProvider,
  ) {}
  private async token(credentials: Credentials) {
    if (this.tokenProvider) return this.tokenProvider(credentials);
    const key = createHash("sha256")
      .update(JSON.stringify(credentials))
      .digest("hex");
    let identity = this.identities.get(key);
    if (!identity) {
      identity = new ClientSecretCredential(
        credentials.tenant,
        credentials.appId,
        credentials.password,
        { retryOptions: { maxRetries: 1 } },
      );
      if (this.identities.size > 100) this.identities.clear();
      this.identities.set(key, identity);
    }
    try {
      return (await identity.getToken("https://management.azure.com/.default"))
        .token;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = message.match(/AADSTS\d+/)?.[0];
      throw new AppError(
        422,
        `Azure 身份验证失败${code ? ` [${code}]` : ""}，请检查租户、应用 ID 和密钥有效期。`,
      );
    }
  }
  async request(
    credentials: Credentials,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: Json; headers: Headers; status: number }> {
    const url = armUrl(path);
    const token = await this.token(credentials);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.gate.run(() =>
          this.transport(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(45000),
            redirect: "error",
          }),
        );
      } catch {
        // A transient connection failure while polling must not replay the write.
        if (method === "GET" && attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new AppError(502, "Azure 请求超时或连接失败，请稍后刷新资源状态");
      }
      // Only retry reads; never resubmit an ambiguous write.
      if (
        method === "GET" &&
        [429, 502, 503, 504].includes(response.status) &&
        attempt < 2
      ) {
        const retry = response.headers.get("retry-after");
        const delay = retry
          ? /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now()
          : 3000 * (attempt + 1);
        await response.body?.cancel();
        if (delay > 60000)
          throw new AppError(429, "Azure 要求较长退避时间，请稍后重试");
        await sleep(Math.max(1000, delay || 3000));
        continue;
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        if (method === "GET" && attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new AppError(502, "读取 Azure 响应超时，请刷新资源状态");
      }
      let data: Json = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new AppError(502, "Azure 返回了无法解析的响应");
        }
      }
      if (!response.ok) {
        const code = String(data.error?.code ?? response.status).replace(
          /[^a-zA-Z0-9_.-]/g,
          "",
        );
        const messages: Record<number, string> = {
          401: "身份凭据已失效",
          403: "权限不足，请检查服务主体 RBAC",
          404: "资源不存在或已删除",
          409: "资源正忙或配置冲突",
          429: "Azure 正在限流，请稍后重试",
        };
        // Azure errors can echo invalid template parameters. Do not persist their raw text.
        const detail =
          method === "GET"
            ? String(data.error?.message ?? "")
                .split(credentials.password)
                .join("[redacted]")
                .slice(0, 600)
            : "";
        throw new AzureError(
          response.status,
          `Azure ${azureFailure(data.error ?? {}, code)} ${messages[response.status] ?? "请求失败"}${detail ? "：" + detail : ""}`,
        );
      }
      return { data, headers: response.headers, status: response.status };
    }
  }
  async list(credentials: Credentials, path: string): Promise<Json[]> {
    const result: Json[] = [];
    const seen = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      const url = armUrl(next).href;
      if (seen.has(url) || seen.size >= 1000)
        throw new AppError(502, "Azure 分页异常，未覆盖本地数据");
      seen.add(url);
      const { data } = await this.request(credentials, "GET", url);
      if (!Array.isArray(data.value))
        throw new AppError(502, "Azure 列表响应无效，未覆盖本地数据");
      result.push(...data.value);
      next = data.nextLink;
    }
    return result;
  }
  async operation(
    credentials: Credentials,
    method: string,
    path: string,
    body?: unknown,
    progress?: (message: string) => void,
  ): Promise<Json> {
    let initial;
    try {
      initial = await this.request(credentials, method, path, body);
    } catch (error) {
      // Only a 404 on the DELETE itself proves an already absent resource.
      // A missing operation-status endpoint is not proof of deletion.
      if (
        method === "DELETE" &&
        error instanceof AzureError &&
        error.azureStatus === 404
      )
        return {};
      throw error;
    }
    const async = initial.headers.get("azure-asyncoperation");
    const location = initial.headers.get("location");
    const state = initial.data.properties?.provisioningState?.toLowerCase();
    if (
      initial.data.error ||
      (method !== "DELETE" &&
        ["failed", "canceled", "cancelled"].includes(state ?? ""))
    ) {
      throw new AppError(
        502,
        `Azure 部署失败 ${azureFailure(initial.data.error ?? {}, state)}`,
      );
    }
    if (
      !async &&
      !location &&
      initial.status !== 202 &&
      (!state || state === "succeeded")
    )
      return initial.data;
    const deadline = Date.now() + 10 * 60_000;
    const pollUrl = armUrl(async ?? location ?? path);
    if (method === "DELETE" && !async && !location) {
      pollUrl.searchParams.delete("forceDeletion");
      pollUrl.searchParams.delete("forceDeletionTypes");
    }
    const pollPath = pollUrl.href;
    if (!async && !location && method === "POST")
      throw new AppError(
        502,
        "Azure 未返回操作进度地址，请刷新资源状态确认结果",
      );
    let pollHeaders = initial.headers;
    while (Date.now() < deadline) {
      const retry = Number(pollHeaders.get("retry-after") ?? 3);
      await sleep(Math.min(30000, Math.max(1000, retry * 1000)));
      let result;
      try {
        result = await this.request(credentials, "GET", pollPath);
      } catch (error) {
        if (
          method === "DELETE" &&
          !async &&
          !location &&
          error instanceof AzureError &&
          error.azureStatus === 404
        )
          return {};
        throw error;
      }
      const status = String(
        result.data.status ?? result.data.properties?.provisioningState ?? "",
      ).toLowerCase();
      pollHeaders = result.headers;
      if (
        ["failed", "canceled", "cancelled"].includes(status) &&
        !(method === "DELETE" && !async && !location && !result.data.error)
      )
        throw new AppError(
          502,
          `Azure 操作${status} ${azureFailure(result.data.error ?? {})}`,
        );
      if (
        (!(method === "DELETE" && !async && !location) &&
          status === "succeeded") ||
        (!async &&
          (location || method !== "DELETE") &&
          !status &&
          [200, 204].includes(result.status))
      )
        return initial.data;
      progress?.(`等待 Azure 操作完成 · ${status || "in progress"}`);
    }
    throw new AppError(
      504,
      "Azure 操作等待超时，云端可能仍在执行。请刷新确认，勿重复提交。",
    );
  }
  async subscriptions(credentials: Credentials): Promise<Subscription[]> {
    return (await this.list(
      credentials,
      "/subscriptions?api-version=2022-12-01",
    )) as Subscription[];
  }
  invalidateCache(key: string) {
    this.cache.delete(key);
    this.loading.delete(key);
    this.cacheEpoch.set(key, (this.cacheEpoch.get(key) ?? 0) + 1);
  }
  primeCache(key: string, value: unknown, ttl: number) {
    this.invalidateCache(key);
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(key, { value, expires: Date.now() + ttl });
  }
  async cached<T>(
    key: string,
    ttl: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value as T;
    const pending = this.loading.get(key);
    if (pending) return pending as Promise<T>;
    const epoch = this.cacheEpoch.get(key) ?? 0;
    const promise = load()
      .then((value) => {
        if (this.cache.size > 500) this.cache.clear();
        if ((this.cacheEpoch.get(key) ?? 0) === epoch)
          this.cache.set(key, { value, expires: Date.now() + ttl });
        return value;
      })
      .finally(() => {
        if (this.loading.get(key) === promise) this.loading.delete(key);
      });
    this.loading.set(key, promise);
    return promise;
  }
  async locations(credentials: Credentials, account: Account) {
    return this.cached(`locations:${account.id}`, 3600000, async () => {
      const data = await this.list(
        credentials,
        `/subscriptions/${account.subscriptionId}/locations?api-version=2022-12-01`,
      );
      return sortRegions(
        data
          .filter(
            (location) =>
              location.name &&
              location.displayName &&
              location.metadata?.regionType === "Physical",
          )
          .map((location) => ({
            name: String(location.name),
            displayName: String(location.displayName),
            regionalDisplayName: String(
              location.regionalDisplayName ?? location.displayName,
            ),
            geography: String(location.metadata?.geography ?? ""),
            geographyGroup: String(location.metadata?.geographyGroup ?? ""),
            continent: regionGroup(location.metadata ?? {}),
          })),
      );
    });
  }
  /** Generic subscription locations do not imply VM/disk/network availability. */
  async vmLocations(credentials: Credentials, account: Account, fresh = false) {
    const key = `vm-locations:${account.id}`;
    if (fresh) {
      this.invalidateCache(key);
      this.invalidateCache(`locations:${account.id}`);
    }
    return this.cached(key, 900000, async () => {
      const locations = await this.locations(credentials, account);
      const providers: Json[] = [];
      for (const namespace of Object.keys(vmResourceTypes)) {
        const { data } = await this.request(
          credentials,
          "GET",
          `/subscriptions/${account.subscriptionId}/providers/${namespace}?api-version=${resources}`,
        );
        if (!Array.isArray(data.resourceTypes))
          throw new AppError(
            502,
            "Azure 未返回资源类型区域信息，无法确认可部署区域",
          );
        providers.push(data);
      }
      return locations.filter(
        (location) => !unsupportedVmResources(location.name, providers).length,
      );
    });
  }
  /** Reads each curated offer's SKUs live from Azure. Cached 24h per account+region. */
  async imageOptions(
    credentials: Credentials,
    account: Account,
    region: string,
  ): Promise<ImageOption[]> {
    return this.cached(`images:${account.id}:${region}`, 86400000, async () => {
      const base = `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/locations/${region}/publishers`;
      const options: ImageOption[] = [];
      for (const target of imageTargets) {
        try {
          // Compute image catalog APIs return a bare array, unlike ARM resource lists.
          const skus = await this.imageCatalogList(
            credentials,
            `${base}/${target.publisher}/artifacttypes/vmimage/offers/${target.offer}/skus?api-version=${compute}`,
          );
          for (const sku of selectGen2Skus(
            skus.map((item) => String(item.name)),
          )) {
            const label = `${target.family} · ${sku}`;
            options.push({
              publisher: target.publisher,
              offer: target.offer,
              sku,
              version: "latest",
              label,
              family: target.family,
              osType: looksLikeWindows({
                publisher: target.publisher,
                offer: target.offer,
                sku,
              })
                ? "Windows"
                : "Linux",
            });
          }
        } catch (error) {
          // A publisher absent from a region is expected; skip it but surface auth failures.
          if (error instanceof AzureError && error.azureStatus === 404)
            continue;
          throw error;
        }
      }
      return options.sort(
        (a, b) =>
          a.family.localeCompare(b.family) || a.sku.localeCompare(b.sku),
      );
    });
  }
  private async imageCatalogList(
    credentials: Credentials,
    path: string,
  ): Promise<Json[]> {
    const { data } = await this.request(credentials, "GET", path);
    if (
      !Array.isArray(data) ||
      !data.every((item) => typeof item.name === "string")
    )
      throw new AppError(502, "Azure 镜像目录响应格式无效");
    return data;
  }
  /** Image GET requires /versions/{version}; /skus/{sku} is not a valid GET endpoint. */
  async assertImageAvailable(
    credentials: Credentials,
    account: Account,
    region: string,
    image: ImageRef,
  ) {
    const path = `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/publishers/${encodeURIComponent(image.publisher)}/artifacttypes/vmimage/offers/${encodeURIComponent(image.offer)}/skus/${encodeURIComponent(image.sku)}/versions`;
    try {
      let resolvedVersion = image.version;
      if (resolvedVersion === "latest") {
        const query = new URLSearchParams({
          "api-version": compute,
          $top: "1",
          $orderby: "name desc",
        });
        const versions = await this.imageCatalogList(
          credentials,
          `${path}?${query}`,
        );
        if (!versions.length)
          throw new AppError(422, "所选镜像在此区域没有可用版本");
        resolvedVersion = versions[0].name;
      }
      const { data } = await this.request(
        credentials,
        "GET",
        `${path}/${encodeURIComponent(resolvedVersion)}?api-version=${compute}`,
      );
      if (!data.properties?.osDiskImage || !data.properties?.hyperVGeneration)
        throw new AppError(502, "Azure 镜像详情响应缺少架构或系统盘信息");
      return {
        reference: { ...image, version: resolvedVersion },
        properties: data.properties,
      };
    } catch (error) {
      if (error instanceof AzureError && error.azureStatus === 404)
        throw new AppError(
          422,
          `所选镜像 ${image.offer}/${image.sku} 在区域 ${region} 不可用，请更换镜像或区域`,
        );
      throw error;
    }
  }
  async skus(
    credentials: Credentials,
    account: Account,
    region: string,
  ): Promise<Sku[]> {
    return this.cached(`skus:${account.id}:${region}`, 900000, async () => {
      const query = new URLSearchParams({
        "api-version": "2021-07-01",
        $filter: `location eq '${region}'`,
      });
      const data = await this.list(
        credentials,
        `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/skus?${query}`,
      );
      return data
        .filter((sku) => sku.resourceType === "virtualMachines")
        .map((sku) => {
          const cap = capabilities(sku);
          return {
            name: sku.name,
            cpus: Number(cap.vCPUs),
            memory: Number(cap.MemoryGB),
            generations: cap.HyperVGenerations ?? "",
            architecture: cap.CpuArchitectureType ?? "x64",
            restricted: (sku.restrictions ?? []).some(
              (r: Json) => r.type === "Location",
            ),
          };
        })
        .sort((a, b) => a.cpus - b.cpus || a.name.localeCompare(b.name));
    });
  }
  async quotas(
    credentials: Credentials,
    account: Account,
    region: string,
  ): Promise<Quota[]> {
    return this.cached(`quotas:${account.id}:${region}`, 300000, async () => {
      const data = await this.list(
        credentials,
        `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/locations/${region}/usages?api-version=${compute}`,
      );
      return data
        .map((value) => ({
          name: value.name.value,
          label: value.name.localizedValue,
          current: value.currentValue,
          limit: value.limit,
        }))
        .sort((a, b) => b.limit - a.limit);
    });
  }
  async groups(credentials: Credentials, account: Account) {
    return this.list(
      credentials,
      `/subscriptions/${account.subscriptionId}/resourcegroups?api-version=${resources}`,
    );
  }
  async groupResources(
    credentials: Credentials,
    account: Account,
    group: string,
  ) {
    return this.list(
      credentials,
      `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(group)}/resources?api-version=${resources}`,
    );
  }
  async previewGroupDeletion(
    credentials: Credentials,
    account: Account,
    group: string,
  ): Promise<GroupDeletionPreview> {
    const items = await this.groupResources(credentials, account, group);
    if (items.some((item) => !item.id || !item.name || !item.type))
      throw new AppError(502, "资源清单不完整，已取消删除；请重新读取");
    const entries = items
      .map((item) => ({
        id: String(item.id),
        name: String(item.name),
        type: String(item.type),
      }))
      .sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          account.subscriptionId.toLowerCase(),
          group.toLowerCase(),
          entries.map((item) => [
            item.id.toLowerCase(),
            item.name.toLowerCase(),
            item.type.toLowerCase(),
          ]),
        ]),
      )
      .digest("hex");
    return { group, fingerprint, resources: entries };
  }
  async assertGroupDeletionUnchanged(
    credentials: Credentials,
    account: Account,
    group: string,
    fingerprint: string,
  ) {
    const current = await this.previewGroupDeletion(
      credentials,
      account,
      group,
    );
    if (current.fingerprint !== fingerprint)
      throw new AppError(
        409,
        `资源组 ${group} 的资源列表已变化，请重新查看清单并确认删除`,
      );
  }
  async deleteGroup(
    credentials: Credentials,
    account: Account,
    group: string,
    fingerprint: string,
    progress?: (message: string) => void,
    forceVmDeletion = false,
  ) {
    // Recheck the complete inventory when the queued task actually starts.
    await this.assertGroupDeletionUnchanged(
      credentials,
      account,
      group,
      fingerprint,
    );
    await this.operation(
      credentials,
      "DELETE",
      `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(group)}?api-version=${resources}${forceVmDeletion ? "&forceDeletionTypes=Microsoft.Compute%2FvirtualMachines" : ""}`,
      undefined,
      progress,
    );
  }
  async previewVmDeletion(
    credentials: Credentials,
    account: Account,
    vm: VirtualMachine,
  ): Promise<VmDeletionPreview> {
    const refuse = (reason: string): VmDeletionPreview => ({
      cleanupAvailable: false,
      reason,
    });
    if (vm.resourceGroup.toLowerCase() !== `${vm.name}-azpanel`.toLowerCase())
      return refuse(
        "此虚拟机不在面板创建的独立资源组中，不能自动整组清理；仅删除 VM 不会清理保留的磁盘、公网 IP 等资源。",
      );
    const root = `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(vm.resourceGroup)}`;
    let group: Json, fresh: Json;
    try {
      group = (
        await this.request(
          credentials,
          "GET",
          `${root}?api-version=${resources}`,
        )
      ).data;
      fresh = (
        await this.request(
          credentials,
          "GET",
          `${vm.resourceId}?api-version=${compute}`,
        )
      ).data;
    } catch (error) {
      if (error instanceof AzureError && error.azureStatus === 404)
        return refuse(
          "云端虚拟机或资源组已不存在，请同步账户；残留资源可在资源浏览器核对后清理。",
        );
      throw error;
    }
    if (
      group.tags?.managedBy !== "azpanel" ||
      fresh.tags?.managedBy !== "azpanel"
    )
      return refuse(
        "无法确认虚拟机和资源组均由面板创建，已禁用自动整组清理；仍可仅删除虚拟机。",
      );
    const prefix = `${root}/providers/`.toLowerCase();
    const disks = [
      fresh.properties?.storageProfile?.osDisk,
      ...(fresh.properties?.storageProfile?.dataDisks ?? []),
    ];
    const attachments = [
      ...disks.flatMap((disk: Json) =>
        disk?.managedDisk?.id ? [disk.managedDisk.id] : [],
      ),
      ...(fresh.properties?.networkProfile?.networkInterfaces ?? []).map(
        (nic: Json) => nic.id,
      ),
    ];
    if (attachments.some((id: string) => !id?.toLowerCase().startsWith(prefix)))
      return refuse(
        "虚拟机关联了其他资源组中的磁盘或网卡，可能包含共享资源；请仅删除 VM 后在资源浏览器逐项处理。",
      );
    const readExisting = async (id: string, version: string): Promise<Json> => {
      try {
        return (
          await this.request(credentials, "GET", `${id}?api-version=${version}`)
        ).data;
      } catch (error) {
        if (error instanceof AzureError && error.azureStatus === 404) return {};
        throw error;
      }
    };
    const nicId = `${root}/providers/Microsoft.Network/networkInterfaces/${vm.name}-nic`;
    const vnetId = `${root}/providers/Microsoft.Network/virtualNetworks/${vm.name}-vnet`;
    const nsgId = `${root}/providers/Microsoft.Network/networkSecurityGroups/${vm.name}-nsg`;
    const ipIds = ["ip", "ip6"].map((suffix) =>
      `${root}/providers/Microsoft.Network/publicIPAddresses/${vm.name}-${suffix}`.toLowerCase(),
    );
    for (const disk of disks) {
      if (disk?.vhd?.uri)
        return refuse(
          "虚拟机使用非托管磁盘，无法从此处确认其数据归属，请在资源浏览器核对后清理。",
        );
      const diskId =
        disk?.managedDisk?.id ??
        (disk?.name
          ? `${root}/providers/Microsoft.Compute/disks/${disk.name}`
          : undefined);
      if (diskId) {
        const current = await readExisting(diskId, "2024-03-02");
        if (
          Number(current.properties?.maxShares ?? 1) > 1 ||
          (current.managedBy &&
            current.managedBy.toLowerCase() !== vm.resourceId.toLowerCase())
        )
          return refuse(
            "虚拟机关联的磁盘可能被其他虚拟机共享，已禁用自动整组清理。",
          );
      }
    }
    for (const nic of fresh.properties?.networkProfile?.networkInterfaces ??
      []) {
      if (nic.id?.toLowerCase() !== nicId.toLowerCase())
        return refuse(
          "虚拟机关联了非预期网卡，请在资源浏览器核对是否存在共享资源后清理。",
        );
      const current = await readExisting(nic.id, network);
      if (
        current.properties?.networkSecurityGroup?.id &&
        current.properties.networkSecurityGroup.id.toLowerCase() !==
          nsgId.toLowerCase()
      )
        return refuse("网卡使用了非预期安全组，已禁用自动整组清理。");
      for (const config of current.properties?.ipConfigurations ?? []) {
        const properties = config.properties ?? {};
        if (
          (properties.subnet?.id &&
            properties.subnet.id.toLowerCase() !==
              `${vnetId}/subnets/default`.toLowerCase()) ||
          (properties.publicIPAddress?.id &&
            !ipIds.includes(properties.publicIPAddress.id.toLowerCase())) ||
          properties.loadBalancerBackendAddressPools?.length ||
          properties.loadBalancerInboundNatRules?.length ||
          properties.applicationGatewayBackendAddressPools?.length
        )
          return refuse(
            "网卡使用了非预期或共享的网络资源，请在资源浏览器核对后清理。",
          );
      }
    }
    const vnet = await readExisting(vnetId, network);
    if (
      vnet.properties?.virtualNetworkPeerings?.length ||
      vnet.properties?.subnets?.some(
        (subnet: Json) =>
          subnet.properties?.ipConfigurations?.some(
            (config: Json) =>
              !config.id
                ?.toLowerCase()
                .startsWith(`${nicId}/ipConfigurations/`.toLowerCase()),
          ) ||
          subnet.properties?.resourceNavigationLinks?.length ||
          subnet.properties?.serviceAssociationLinks?.length,
      )
    )
      return refuse(
        "虚拟网络存在对等连接或其他关联资源，请在资源浏览器核对共享关系后清理。",
      );
    const nsg = await readExisting(nsgId, network);
    if (
      nsg.properties?.networkInterfaces?.some(
        (nic: Json) => nic.id?.toLowerCase() !== nicId.toLowerCase(),
      ) ||
      nsg.properties?.subnets?.some(
        (subnet: Json) =>
          !subnet.id
            ?.toLowerCase()
            .startsWith(`${vnetId}/subnets/`.toLowerCase()),
      )
    )
      return refuse("安全组被其他网卡或虚拟网络共享，已禁用自动整组清理。");
    for (const id of ipIds) {
      const current = await readExisting(id, network);
      const configId = current.properties?.ipConfiguration?.id;
      if (
        configId &&
        !configId
          .toLowerCase()
          .startsWith(`${nicId}/ipConfigurations/`.toLowerCase())
      )
        return refuse(
          "公网 IP 已关联其他网卡或服务，请在资源浏览器核对后清理。",
        );
    }
    const preview = await this.previewGroupDeletion(
      credentials,
      account,
      vm.resourceGroup,
    );
    const allowed = new Set(
      [
        vm.resourceId,
        nsgId,
        ...ipIds,
        vnetId,
        nicId,
        ...attachments,
        ...disks.flatMap((disk: Json) =>
          disk?.name
            ? [`${root}/providers/Microsoft.Compute/disks/${disk.name}`]
            : [],
        ),
      ].map((id) => id.toLowerCase()),
    );
    const unknown = preview.resources.filter(
      (item) => !allowed.has(item.id.toLowerCase()),
    );
    if (unknown.length)
      return refuse(
        `资源组包含无法确认归属的资源：${unknown.map((item) => `${item.name}（${item.type}）`).join("、")}。为避免误删，不能从 VM 页面自动清理；请前往资源浏览器核对整组清单。`,
      );
    if (
      !preview.resources.some(
        (item) => item.id.toLowerCase() === vm.resourceId.toLowerCase(),
      )
    )
      return refuse("资源清单中未找到当前虚拟机，请同步后重新操作。");
    return { cleanupAvailable: true, group: preview };
  }
  async assertVmCleanupUnchanged(
    credentials: Credentials,
    account: Account,
    vm: VirtualMachine,
    fingerprint: string,
  ) {
    const preview = await this.previewVmDeletion(credentials, account, vm);
    if (!preview.cleanupAvailable || preview.group?.fingerprint !== fingerprint)
      throw new AppError(
        409,
        preview.reason ?? "附属资源清单已变化，请重新打开删除弹窗核对并确认",
      );
  }
  async deleteVmAndResources(
    credentials: Credentials,
    account: Account,
    vm: VirtualMachine,
    fingerprint: string,
    progress: (message: string) => void,
    force = false,
  ) {
    await this.assertVmCleanupUnchanged(credentials, account, vm, fingerprint);
    progress(`删除虚拟机及独立资源组 ${vm.resourceGroup} 内的全部资源`);
    await this.deleteGroup(
      credentials,
      account,
      vm.resourceGroup,
      fingerprint,
      progress,
      force,
    );
  }
  async machines(
    credentials: Credentials,
    account: Account,
  ): Promise<{ vm: VirtualMachine; raw: Json }[]> {
    const data = await this.list(
      credentials,
      `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=${compute}`,
    );
    const result: { vm: VirtualMachine; raw: Json }[] = [];
    for (const raw of data) {
      const readOptional = async (path: string): Promise<Json> => {
        try {
          return (await this.request(credentials, "GET", path)).data;
        } catch (error) {
          // Partially provisioned VMs can lack an instance view, NIC or public IP.
          // Permission, throttling and other failures must still reject the snapshot.
          if (error instanceof AzureError && error.azureStatus === 404)
            return {};
          throw error;
        }
      };
      const view = await readOptional(
        `${raw.id}/instanceView?api-version=${compute}`,
      );
      const publicIps: string[] = [],
        privateIps: string[] = [];
      for (const nic of raw.properties?.networkProfile?.networkInterfaces ??
        []) {
        const networkData = await readOptional(
          `${nic.id}?api-version=${network}`,
        );
        for (const config of networkData.properties?.ipConfigurations ?? []) {
          if (config.properties?.privateIPAddress)
            privateIps.push(config.properties.privateIPAddress);
          const id = config.properties?.publicIPAddress?.id;
          if (id) {
            const ip = await readOptional(`${id}?api-version=${network}`);
            if (ip.properties?.ipAddress)
              publicIps.push(ip.properties.ipAddress);
          }
        }
      }
      result.push({
        raw,
        vm: {
          id: createHash("sha256")
            .update(account.id + ":" + raw.id.toLowerCase())
            .digest("hex")
            .slice(0, 32),
          accountId: account.id,
          accountLabel: account.label,
          name: raw.name,
          resourceGroup: raw.id.split("/")[4],
          resourceId: raw.id,
          location: raw.location,
          size: raw.properties?.hardwareProfile?.vmSize ?? "Unknown",
          os: raw.properties?.storageProfile?.osDisk?.osType ?? "Unknown",
          powerState: powerState(view),
          provisioningState: raw.properties?.provisioningState ?? "Unknown",
          publicIps,
          privateIps,
          diskSize: raw.properties?.storageProfile?.osDisk?.diskSizeGB ?? 0,
          tags: raw.tags ?? {},
          syncedAt: Date.now(),
        },
      });
    }
    return result;
  }
  async metrics(
    credentials: Credentials,
    vm: VirtualMachine,
  ): Promise<MetricPoint[]> {
    return this.cached(`metrics:${vm.id}`, 300000, async () => {
      const query = new URLSearchParams({
        "api-version": "2023-10-01",
        timespan: `${new Date(Date.now() - 86400000).toISOString()}/${new Date().toISOString()}`,
        interval: "PT1H",
        aggregation: "Average,Total",
        metricnames: "Percentage CPU,Network In Total,Network Out Total",
      });
      const { data } = await this.request(
        credentials,
        "GET",
        `${vm.resourceId}/providers/Microsoft.Insights/metrics?${query}`,
      );
      const points = new Map<string, MetricPoint>();
      const keys: Record<string, "cpu" | "networkIn" | "networkOut"> = {
        "Percentage CPU": "cpu",
        "Network In Total": "networkIn",
        "Network Out Total": "networkOut",
      };
      for (const metric of data.value ?? [])
        for (const point of metric.timeseries?.[0]?.data ?? []) {
          const key = keys[metric.name.value];
          if (!key) continue;
          const entry = points.get(point.timeStamp) ?? {
            time: point.timeStamp,
            cpu: null,
            networkIn: null,
            networkOut: null,
          };
          entry[key] =
            key === "cpu" ? (point.average ?? null) : (point.total ?? null);
          points.set(point.timeStamp, entry);
        }
      return [...points.values()].sort((a, b) => a.time.localeCompare(b.time));
    });
  }
  async create(
    credentials: Credentials,
    account: Account,
    input: CreateVm,
    progress: (message: string) => void,
  ) {
    progress("检查实体部署区域");
    if (
      !(await this.locations(credentials, account)).some(
        (region) => region.name === input.location,
      )
    )
      throw new AppError(
        422,
        "请选择 Azure 返回的实体部署区域，不能使用 asia 等逻辑区域",
      );
    const sku = (await this.skus(credentials, account, input.location)).find(
      (sku) => sku.name === input.size,
    );
    if (!sku || sku.restricted || sku.architecture.toLowerCase() === "arm64")
      throw new AppError(422, "所选规格不可用或架构不兼容");
    if (!sku.generations.includes("V2"))
      throw new AppError(422, "当前镜像需要支持 Gen2 的规格");
    progress("确认所选镜像在目标区域可用");
    const image = await this.assertImageAvailable(
      credentials,
      account,
      input.location,
      input.image,
    );
    if (
      image.properties.hyperVGeneration !== "V2" ||
      String(image.properties.architecture ?? "x64").toLowerCase() !== "x64"
    )
      throw new AppError(422, "当前创建配置仅支持 Gen2 x64 镜像，请更换镜像");
    if (input.diskSize < Number(image.properties.osDiskImage.sizeInGb ?? 0))
      throw new AppError(
        422,
        `所选镜像的系统盘至少需要 ${image.properties.osDiskImage.sizeInGb} GiB`,
      );
    if (image.properties.purchasePlan)
      throw new AppError(
        422,
        "所选 Marketplace 镜像需要购买计划，请通过 Azure Portal 接受条款并部署，或选择无购买计划的镜像",
      );
    const root = `/subscriptions/${account.subscriptionId}/resourceGroups/${input.name}-azpanel`;
    const groups = await this.groups(credentials, account);
    if (
      groups.some(
        (group) =>
          group.name.toLowerCase() === `${input.name}-azpanel`.toLowerCase(),
      )
    )
      throw new AppError(409, "同名资源组已存在，请使用新的虚拟机名称");
    const providers: Json[] = [];
    progress("检查虚拟机、托管磁盘和网络资源的区域支持");
    for (const provider of Object.keys(vmResourceTypes)) {
      const path = `/subscriptions/${account.subscriptionId}/providers/${provider}`;
      let { data } = await this.request(
        credentials,
        "GET",
        `${path}?api-version=${resources}`,
      );
      if (data.registrationState !== "Registered") {
        progress(`注册资源提供程序 ${provider}`);
        await this.request(
          credentials,
          "POST",
          `${path}/register?api-version=${resources}`,
        );
        const deadline = Date.now() + 180000;
        let registered = false;
        while (Date.now() < deadline) {
          await sleep(3000);
          const result = await this.request(
            credentials,
            "GET",
            `${path}?api-version=${resources}`,
          );
          if (result.data.registrationState === "Registered") {
            data = result.data;
            registered = true;
            break;
          }
        }
        if (!registered)
          throw new AppError(
            504,
            `资源提供程序 ${provider} 仍在注册，请稍后重新创建`,
          );
      }
      if (!Array.isArray(data.resourceTypes))
        throw new AppError(
          502,
          "Azure 未返回资源类型区域信息，已停止创建，未创建资源组",
        );
      providers.push(data);
    }
    const unsupported = unsupportedVmResources(input.location, providers);
    if (unsupported.length)
      throw new AppError(
        422,
        `当前订阅在区域 ${input.location} 不支持 ${unsupported.join("、")}。已停止创建，未创建资源组；请更换区域或联系 Azure 支持确认访问权限。`,
      );
    const deployment = deploymentTemplate({ ...input, image: image.reference });
    try {
      progress("创建独立资源组");
      await this.operation(
        credentials,
        "PUT",
        `${root}?api-version=${resources}`,
        { location: input.location, tags: { managedBy: "azpanel" } },
        progress,
      );
      progress("验证 Azure 部署模板");
      await this.operation(
        credentials,
        "POST",
        `${root}/providers/Microsoft.Resources/deployments/azpanel/validate?api-version=2022-09-01`,
        {
          properties: {
            mode: "Incremental",
            template: deployment.template,
            parameters: deployment.parameters,
          },
        },
        progress,
      );
      progress("提交部署：网络、安全组、公网 IP 和虚拟机");
      await this.operation(
        credentials,
        "PUT",
        `${root}/providers/Microsoft.Resources/deployments/azpanel?api-version=2022-09-01`,
        {
          properties: {
            mode: "Incremental",
            template: deployment.template,
            parameters: deployment.parameters,
          },
        },
        progress,
      );
    } catch (error) {
      if (error instanceof AppError)
        throw new AppError(
          error.status,
          `${error.message}。资源组 ${input.name}-azpanel 可能有残留资源，请在资源浏览器核对清单后删除；不要重复提交同名创建。`,
        );
      throw error;
    }
  }
  async vmAction(
    credentials: Credentials,
    vm: VirtualMachine,
    action: string,
    progress: (message: string) => void,
  ) {
    await this.operation(
      credentials,
      "POST",
      `${vm.resourceId}/${action}?api-version=${compute}`,
      undefined,
      progress,
    );
  }
  async resize(
    credentials: Credentials,
    vm: VirtualMachine,
    size: string,
    progress: (message: string) => void,
  ) {
    await this.operation(
      credentials,
      "PATCH",
      `${vm.resourceId}?api-version=${compute}`,
      { properties: { hardwareProfile: { vmSize: size } } },
      progress,
    );
  }
  async resizeDisk(
    credentials: Credentials,
    vm: VirtualMachine,
    size: number,
    progress: (message: string) => void,
  ) {
    const { data: fresh } = await this.request(
      credentials,
      "GET",
      `${vm.resourceId}?api-version=${compute}`,
    );
    const diskId = fresh.properties.storageProfile.osDisk.managedDisk?.id;
    if (!diskId) throw new AppError(422, "只支持托管系统盘扩容");
    const { data: disk } = await this.request(
      credentials,
      "GET",
      `${diskId}?api-version=2024-03-02`,
    );
    if (size <= disk.properties.diskSizeGB)
      throw new AppError(422, "只能扩容，不能缩小系统盘");
    const { data: view } = await this.request(
      credentials,
      "GET",
      `${vm.resourceId}/instanceView?api-version=${compute}`,
    );
    if (powerState(view) !== "deallocated")
      throw new AppError(422, "扩容前请先停止并释放虚拟机");
    await this.operation(
      credentials,
      "PATCH",
      `${diskId}?api-version=2024-03-02`,
      { properties: { diskSizeGB: size } },
      progress,
    );
  }
  async deleteVm(
    credentials: Credentials,
    vm: VirtualMachine,
    progress: (message: string) => void,
    force = false,
  ) {
    progress(force ? "强制删除虚拟机（跳过正常关机）" : "删除虚拟机");
    await this.operation(
      credentials,
      "DELETE",
      `${vm.resourceId}?api-version=${compute}${force ? "&forceDeletion=true" : ""}`,
      undefined,
      progress,
    );
  }
}

export function deploymentTemplate(input: CreateVm) {
  const name = input.name;
  const image = {
    publisher: input.image.publisher,
    offer: input.image.offer,
    sku: input.image.sku,
    version: input.image.version || "latest",
  };
  const id = (type: string, suffix: string) =>
    `[resourceId('${type}', '${name}-${suffix}')]`;
  const nsg = id("Microsoft.Network/networkSecurityGroups", "nsg");
  const ip = id("Microsoft.Network/publicIPAddresses", "ip");
  const ip6 = id("Microsoft.Network/publicIPAddresses", "ip6");
  const vnet = id("Microsoft.Network/virtualNetworks", "vnet");
  const nic = id("Microsoft.Network/networkInterfaces", "nic");
  const subnet = `[resourceId('Microsoft.Network/virtualNetworks/subnets', '${name}-vnet', 'default')]`;
  const templateResources: Json[] = [
    {
      type: "Microsoft.Network/networkSecurityGroups",
      apiVersion: network,
      name: `${name}-nsg`,
      location: input.location,
      properties: {
        securityRules: [
          {
            name: "allow-all-inbound",
            properties: {
              priority: 100,
              access: "Allow",
              direction: "Inbound",
              protocol: "*",
              sourceAddressPrefix: "*",
              sourcePortRange: "*",
              destinationAddressPrefix: "*",
              destinationPortRange: "*",
            },
          },
        ],
      },
    },
    {
      type: "Microsoft.Network/virtualNetworks",
      apiVersion: network,
      name: `${name}-vnet`,
      location: input.location,
      properties: {
        addressSpace: {
          addressPrefixes: input.ipv6
            ? ["10.42.0.0/16", "fd00:42::/48"]
            : ["10.42.0.0/16"],
        },
        subnets: [
          {
            name: "default",
            properties: input.ipv6
              ? {
                  addressPrefixes: ["10.42.0.0/24", "fd00:42:0:1::/64"],
                  defaultOutboundAccess: false,
                }
              : { addressPrefix: "10.42.0.0/24", defaultOutboundAccess: false },
          },
        ],
      },
    },
    {
      type: "Microsoft.Network/networkInterfaces",
      apiVersion: network,
      name: `${name}-nic`,
      location: input.location,
      dependsOn: [
        nsg,
        vnet,
        ...(input.publicIpv4 ? [ip] : []),
        ...(input.ipv6 ? [ip6] : []),
      ],
      properties: {
        networkSecurityGroup: { id: nsg },
        ipConfigurations: [
          {
            name: "ipv4",
            properties: {
              primary: true,
              privateIPAllocationMethod: "Dynamic",
              privateIPAddressVersion: "IPv4",
              subnet: { id: subnet },
              ...(input.publicIpv4 ? { publicIPAddress: { id: ip } } : {}),
            },
          },
          ...(input.ipv6
            ? [
                {
                  name: "ipv6",
                  properties: {
                    primary: false,
                    privateIPAllocationMethod: "Dynamic",
                    privateIPAddressVersion: "IPv6",
                    subnet: { id: subnet },
                    publicIPAddress: { id: ip6 },
                  },
                },
              ]
            : []),
        ],
      },
    },
    {
      type: "Microsoft.Compute/virtualMachines",
      apiVersion: compute,
      name,
      location: input.location,
      tags: { managedBy: "azpanel" },
      dependsOn: [nic],
      properties: {
        hardwareProfile: { vmSize: input.size },
        storageProfile: {
          imageReference: image,
          osDisk: {
            createOption: "FromImage",
            diskSizeGB: input.diskSize,
            managedDisk: { storageAccountType: "StandardSSD_LRS" },
            deleteOption: "Detach",
          },
        },
        osProfile: {
          computerName: name,
          adminUsername: input.username,
          ...(input.authentication === "ssh"
            ? {
                linuxConfiguration: {
                  disablePasswordAuthentication: true,
                  ssh: {
                    publicKeys: [
                      {
                        path: `/home/${input.username}/.ssh/authorized_keys`,
                        keyData: input.sshKey.trim(),
                      },
                    ],
                  },
                },
              }
            : { adminPassword: "[parameters('adminPassword')]" }),
          ...(input.customData
            ? { customData: Buffer.from(input.customData).toString("base64") }
            : {}),
        },
        networkProfile: {
          networkInterfaces: [
            { id: nic, properties: { primary: true, deleteOption: "Detach" } },
          ],
        },
      },
    },
  ];
  if (input.publicIpv4)
    templateResources.push({
      type: "Microsoft.Network/publicIPAddresses",
      apiVersion: network,
      name: `${name}-ip`,
      location: input.location,
      sku: { name: "Standard" },
      properties: {
        publicIPAllocationMethod: "Static",
        publicIPAddressVersion: "IPv4",
      },
    });
  if (input.ipv6)
    templateResources.push({
      type: "Microsoft.Network/publicIPAddresses",
      apiVersion: network,
      name: `${name}-ip6`,
      location: input.location,
      sku: { name: "Standard" },
      properties: {
        publicIPAllocationMethod: "Static",
        publicIPAddressVersion: "IPv6",
      },
    });
  return {
    template: {
      $schema:
        "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      parameters:
        input.authentication === "password"
          ? { adminPassword: { type: "secureString" } }
          : {},
      resources: templateResources,
    },
    parameters:
      input.authentication === "password"
        ? { adminPassword: { value: input.password } }
        : {},
  };
}

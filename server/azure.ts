import { ClientSecretCredential } from "@azure/identity";
import { createHash } from "node:crypto";
import type {
  Account,
  Credentials,
  Json,
  MetricPoint,
  Quota,
  Sku,
  Subscription,
  VirtualMachine,
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

const ARM = "https://management.azure.com";
const compute = "2024-11-01";
const network = "2023-11-01";
const resources = "2021-04-01";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Transport = typeof fetch;
type TokenProvider = (credentials: Credentials) => Promise<string>;
class AzureError extends AppError {
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
          `Azure [${code}] ${messages[response.status] ?? "请求失败"}${detail ? "：" + detail : ""}`,
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
    const initial = await this.request(credentials, method, path, body);
    const async = initial.headers.get("azure-asyncoperation");
    const location = initial.headers.get("location");
    const state = initial.data.properties?.provisioningState?.toLowerCase();
    if (
      initial.data.error ||
      ["failed", "canceled", "cancelled"].includes(state ?? "")
    ) {
      throw new AppError(
        502,
        `Azure 部署失败 [${initial.data.error?.code ?? state}]`,
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
    const pollPath = async ?? location ?? path;
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
      if (["failed", "canceled", "cancelled"].includes(status))
        throw new AppError(
          502,
          `Azure 部署${status} [${result.data.error?.code ?? "OperationFailed"}]`,
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
  private async cached<T>(
    key: string,
    ttl: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value as T;
    const pending = this.loading.get(key);
    if (pending) return pending as Promise<T>;
    const promise = load()
      .then((value) => {
        if (this.cache.size > 500) this.cache.clear();
        this.cache.set(key, { value, expires: Date.now() + ttl });
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, promise);
    return promise;
  }
  async locations(credentials: Credentials, account: Account) {
    return this.cached(`locations:${account.id}`, 3600000, async () => {
      const data = await this.list(
        credentials,
        `/subscriptions/${account.subscriptionId}/locations?api-version=2022-12-01`,
      );
      return data
        .filter((location) => location.name && location.displayName)
        .map((location) => ({
          name: String(location.name),
          displayName: String(location.displayName),
          regionalDisplayName: String(
            location.regionalDisplayName ?? location.displayName,
          ),
          geography: String(location.metadata?.geography ?? ""),
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "en"));
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
          const skus = await this.list(
            credentials,
            `${base}/${target.publisher}/artifacttypes/vmimage/offers/${target.offer}/skus?api-version=2024-11-01`,
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
  /** Confirms the selected publisher/offer/sku exists in the region before deploying. */
  async assertImageAvailable(
    credentials: Credentials,
    account: Account,
    region: string,
    image: ImageRef,
  ) {
    const path = `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/locations/${region}/publishers/${image.publisher}/artifacttypes/vmimage/offers/${image.offer}/skus/${image.sku}`;
    try {
      await this.request(credentials, "GET", `${path}?api-version=2024-11-01`);
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
      const { data: view } = await this.request(
        credentials,
        "GET",
        `${raw.id}/instanceView?api-version=${compute}`,
      );
      const publicIps: string[] = [],
        privateIps: string[] = [];
      for (const nic of raw.properties.networkProfile?.networkInterfaces ??
        []) {
        const { data: networkData } = await this.request(
          credentials,
          "GET",
          `${nic.id}?api-version=${network}`,
        );
        for (const config of networkData.properties?.ipConfigurations ?? []) {
          if (config.properties?.privateIPAddress)
            privateIps.push(config.properties.privateIPAddress);
          const id = config.properties?.publicIPAddress?.id;
          if (id) {
            const { data: ip } = await this.request(
              credentials,
              "GET",
              `${id}?api-version=${network}`,
            );
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
          size: raw.properties.hardwareProfile.vmSize,
          os: raw.properties.storageProfile.osDisk.osType ?? "Unknown",
          powerState: powerState(view),
          provisioningState: raw.properties.provisioningState ?? "Unknown",
          publicIps,
          privateIps,
          diskSize: raw.properties.storageProfile.osDisk.diskSizeGB ?? 0,
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
    const sku = (await this.skus(credentials, account, input.location)).find(
      (sku) => sku.name === input.size,
    );
    if (!sku || sku.restricted || sku.architecture.toLowerCase() === "arm64")
      throw new AppError(422, "所选规格不可用或架构不兼容");
    if (!sku.generations.includes("V2"))
      throw new AppError(422, "当前镜像需要支持 Gen2 的规格");
    progress("确认所选镜像在目标区域可用");
    await this.assertImageAvailable(
      credentials,
      account,
      input.location,
      input.image,
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
    for (const provider of ["Microsoft.Compute", "Microsoft.Network"]) {
      const path = `/subscriptions/${account.subscriptionId}/providers/${provider}`;
      const { data } = await this.request(
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
    }
    const deployment = deploymentTemplate(input);
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
  ) {
    await this.operation(
      credentials,
      "DELETE",
      `${vm.resourceId}?api-version=${compute}`,
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
  const windows = looksLikeWindows(input.image);
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
            name: "admin-access",
            properties: {
              priority: 100,
              access: "Allow",
              direction: "Inbound",
              protocol: "Tcp",
              sourceAddressPrefix: input.allowedSource,
              sourcePortRange: "*",
              destinationAddressPrefix: "*",
              destinationPortRange: windows ? "3389" : "22",
            },
          },
        ],
      },
    },
    {
      type: "Microsoft.Network/publicIPAddresses",
      apiVersion: network,
      name: `${name}-ip`,
      location: input.location,
      sku: { name: "Standard" },
      properties: {
        publicIPAllocationMethod: "Static",
        publicIPAddressVersion: "IPv4",
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
      dependsOn: [nsg, ip, vnet, ...(input.ipv6 ? [ip6] : [])],
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
              publicIPAddress: { id: ip },
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
          imageReference: { ...image, version: "latest" },
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

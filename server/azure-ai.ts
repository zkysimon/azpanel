import { Azure, AzureError } from "./azure.js";
import { createHash } from "node:crypto";
import { AppError } from "./store.js";
import type { Account, Credentials } from "../shared/types.js";
import type {
  AiCreateService,
  AiDeploy,
  AiDeployment,
  AiModel,
  AiService,
  AiServiceRef,
  AiUsage,
} from "../shared/ai.js";

const version = "2024-10-01";
export class AzureAi {
  constructor(private azure: Azure) {}
  private root(account: Account, service: AiServiceRef) {
    return `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(service.group)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(service.name)}`;
  }
  private key(
    credentials: Credentials,
    account: Account,
    kind: string,
    service?: AiServiceRef,
  ) {
    const identity = createHash("sha256")
      .update(JSON.stringify(credentials))
      .digest("hex");
    return `ai:${account.id}:${identity}:${kind}${service ? ":" + this.root(account, service).toLowerCase() : ""}`;
  }
  async services(
    credentials: Credentials,
    account: Account,
    fresh = false,
  ): Promise<AiService[]> {
    const key = this.key(credentials, account, "services");
    if (fresh) this.azure.invalidateCache(key);
    return this.azure.cached(key, 60000, async () => {
      const values = await this.azure.list(
        credentials,
        `/subscriptions/${account.subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=${version}`,
      );
      return values
        .filter((item) => ["OpenAI", "AIServices"].includes(item.kind))
        .map((item) => {
          const ref = { group: item.id.split("/")[4], name: item.name };
          this.azure.primeCache(
            this.key(credentials, account, "service", ref),
            item,
            60000,
          );
          return {
            id: item.id,
            group: item.id.split("/")[4],
            name: item.name,
            kind: item.kind,
            location: item.location,
            state: item.properties?.provisioningState ?? "Unknown",
            endpoint: item.properties?.endpoint ?? null,
          };
        });
    });
  }
  private async verifyService(
    credentials: Credentials,
    account: Account,
    service: AiServiceRef,
    fresh = false,
  ) {
    const key = this.key(credentials, account, "service", service);
    if (fresh) this.azure.invalidateCache(key);
    return this.azure.cached(key, 60000, async () => {
      const { data } = await this.azure.request(
        credentials,
        "GET",
        `${this.root(account, service)}?api-version=${version}`,
      );
      if (!["OpenAI", "AIServices"].includes(data.kind))
        throw new AppError(422, "请选择 Azure OpenAI 或 AI Services 资源");
      return data;
    });
  }
  async models(
    credentials: Credentials,
    account: Account,
    service: AiServiceRef,
    fresh = false,
  ): Promise<AiModel[]> {
    const key = this.key(credentials, account, "models", service);
    if (fresh) this.azure.invalidateCache(key);
    return this.azure.cached(key, 3600000, async () => {
      await this.verifyService(credentials, account, service);
      const models = await this.azure.list(
        credentials,
        `${this.root(account, service)}/models?api-version=${version}`,
      );
      return models
        .filter((item) => item.name && item.format && item.version)
        .map((item) => ({
          name: item.name,
          format: item.format,
          version: item.version,
          publisher: item.publisher ?? "",
          lifecycle: item.lifecycleStatus ?? "Unknown",
          capabilities: item.capabilities ?? {},
          skus: (item.skus ?? [])
            .filter((sku: { name?: string }) => sku.name)
            .map((sku: any) => ({
              name: sku.name,
              usageName: sku.usageName ?? null,
              minimum: sku.capacity?.minimum ?? 1,
              maximum: sku.capacity?.maximum ?? item.maxCapacity ?? null,
              step: sku.capacity?.step ?? 1,
              default: sku.capacity?.default ?? sku.capacity?.minimum ?? 1,
              azureDefault: sku.capacity?.default ?? null,
              defaultSource:
                sku.capacity?.default != null
                  ? "azure"
                  : sku.capacity?.minimum != null
                    ? "minimum"
                    : "fallback",
              allowedValues: sku.capacity?.allowedValues ?? [],
            })),
        }));
    });
  }
  async deployments(
    credentials: Credentials,
    account: Account,
    service: AiServiceRef,
    fresh = false,
  ): Promise<AiDeployment[]> {
    const key = this.key(credentials, account, "deployments", service);
    if (fresh) this.azure.invalidateCache(key);
    return this.azure.cached(key, 15000, async () => {
      await this.verifyService(credentials, account, service);
      return (
        await this.azure.list(
          credentials,
          `${this.root(account, service)}/deployments?api-version=${version}`,
        )
      ).map((item) => ({
        name: item.name,
        model: {
          format: item.properties?.model?.format ?? "",
          name: item.properties?.model?.name ?? "",
          version: item.properties?.model?.version ?? "",
        },
        sku: item.sku?.name ?? "",
        capacity: item.sku?.capacity ?? 0,
        state: item.properties?.provisioningState ?? "Unknown",
      }));
    });
  }
  async usages(
    credentials: Credentials,
    account: Account,
    service: AiServiceRef,
  ): Promise<AiUsage[]> {
    return this.azure.cached(
      this.key(credentials, account, "usages", service),
      60000,
      async () => {
        await this.verifyService(credentials, account, service);
        return (
          await this.azure.list(
            credentials,
            `${this.root(account, service)}/usages?api-version=${version}`,
          )
        ).map((item) => ({
          name: item.name?.value ?? "",
          label: item.name?.localizedValue ?? item.name?.value ?? "",
          current: item.currentValue ?? 0,
          limit: item.limit ?? 0,
          unit: item.unit ?? "",
        }));
      },
    );
  }
  async createService(
    credentials: Credentials,
    account: Account,
    input: AiCreateService,
    progress: (message: string) => void,
  ) {
    // An existing group is selected explicitly; do not create or replace other resources.
    await this.azure.request(
      credentials,
      "GET",
      `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(input.group)}?api-version=2021-04-01`,
    );
    try {
      await this.azure.request(
        credentials,
        "GET",
        `${this.root(account, input)}?api-version=${version}`,
      );
      throw new AppError(409, "同名资源已存在，创建操作不会覆盖已有服务");
    } catch (error) {
      if (!(error instanceof AzureError && error.azureStatus === 404))
        throw error;
    }
    const providerPath = `/subscriptions/${account.subscriptionId}/providers/Microsoft.CognitiveServices`;
    const provider = await this.azure.request(
      credentials,
      "GET",
      `${providerPath}?api-version=2021-04-01`,
    );
    if (provider.data.registrationState !== "Registered") {
      throw new AppError(
        422,
        "请先在 Azure Portal 的订阅资源提供程序中注册 Microsoft.CognitiveServices",
      );
    }
    progress("创建 AI 服务资源");
    try {
      await this.azure.operation(
        credentials,
        "PUT",
        `${this.root(account, input)}?api-version=${version}`,
        {
          kind: input.kind,
          location: input.location,
          sku: { name: "S0" },
          properties: {
            customSubDomainName: input.name,
            publicNetworkAccess: "Enabled",
          },
          tags: { managedBy: "azpanel" },
        },
        progress,
      );
    } finally {
      this.azure.invalidateCache(this.key(credentials, account, "services"));
      this.azure.invalidateCache(
        this.key(credentials, account, "service", input),
      );
    }
  }
  async deploy(
    credentials: Credentials,
    account: Account,
    input: AiDeploy,
    progress: (message: string) => void,
  ) {
    progress("检查模型版本、部署类型和容量");
    await this.verifyService(credentials, account, input, true);
    const model = (await this.models(credentials, account, input, true)).find(
      (item) =>
        item.format === input.model.format &&
        item.name === input.model.name &&
        item.version === input.model.version,
    );
    if (!model || model.lifecycle === "Deprecated")
      throw new AppError(422, "当前 AI 资源不支持所选模型版本，或模型已退役");
    const sku = model.skus.find((item) => item.name === input.sku);
    if (!sku)
      throw new AppError(422, "此模型不支持所选部署类型，请重新读取模型目录");
    if (
      input.capacity < sku.minimum ||
      (sku.maximum !== null && input.capacity > sku.maximum) ||
      (input.capacity - sku.minimum) % Math.max(1, sku.step) !== 0 ||
      (sku.allowedValues.length > 0 &&
        !sku.allowedValues.includes(input.capacity))
    ) {
      throw new AppError(422, "容量不符合 Azure 返回的允许范围或步长");
    }
    const deployments = await this.deployments(
      credentials,
      account,
      input,
      true,
    );
    if (
      deployments.some(
        (item) => item.name.toLowerCase() === input.deployment.toLowerCase(),
      )
    )
      throw new AppError(409, "部署名称已存在，请使用新名称");
    progress(`部署 ${input.model.name} · ${input.model.version}`);
    try {
      await this.azure.operation(
        credentials,
        "PUT",
        `${this.root(account, input)}/deployments/${encodeURIComponent(input.deployment)}?api-version=${version}`,
        {
          sku: { name: input.sku, capacity: input.capacity },
          properties: { model: input.model },
        },
        progress,
      );
    } finally {
      this.azure.invalidateCache(
        this.key(credentials, account, "deployments", input),
      );
      this.azure.invalidateCache(
        this.key(credentials, account, "usages", input),
      );
    }
  }
  async deleteDeployment(
    credentials: Credentials,
    account: Account,
    service: AiServiceRef,
    deployment: string,
    progress: (message: string) => void,
  ) {
    await this.verifyService(credentials, account, service, true);
    progress(`删除模型部署 ${deployment}`);
    try {
      await this.azure.operation(
        credentials,
        "DELETE",
        `${this.root(account, service)}/deployments/${encodeURIComponent(deployment)}?api-version=${version}`,
        undefined,
        progress,
      );
    } finally {
      this.azure.invalidateCache(
        this.key(credentials, account, "deployments", service),
      );
      this.azure.invalidateCache(
        this.key(credentials, account, "usages", service),
      );
    }
  }
}

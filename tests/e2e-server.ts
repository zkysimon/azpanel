// Isolated in-memory database, synthetic credentials, no external Azure requests.
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { Azure, RequestGate } from "../server/azure.js";
import { account, credentials, machine, testConfig } from "./fixtures.js";

const aiRoot = `/subscriptions/${account.subscriptionId}/resourceGroups/ai-group/providers/Microsoft.CognitiveServices/accounts/test-ai`;
const aiDeployments: Record<string, any> = {};

const store = new Store(testConfig, true);
const admin = store.db.prepare("SELECT id FROM users LIMIT 1").get() as {
  id: string;
};
// Registration is open and has a known invite code for the browser test.
store.setSetting("registration_open", "1");
store.createInvite({
  id: "invite-1",
  code: "TEST-CODE-0001",
  note: "浏览器测试",
  maxUses: 0,
  uses: 0,
  expiresAt: null,
  createdAt: Date.now(),
  createdBy: testConfig.adminEmail,
  lastUsedAt: null,
});
store.saveAccount(admin.id, account, credentials);
store.replaceMachines(account.id, [
  { vm: machine, raw: {} },
  {
    vm: {
      ...machine,
      id: "test-vm-2",
      name: "worker-02",
      location: "japaneast",
      powerState: "deallocated",
      publicIps: [],
    },
    raw: {},
  },
]);
store.audit(admin.id, "接入账户", account.label);
store.audit(admin.id, "同步资源", "2 台虚拟机");
const azure = new Azure(
  new RequestGate(0),
  async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/Microsoft.CognitiveServices/")) {
      if (path.endsWith("/models"))
        return Response.json({
          value: [
            {
              name: "gpt-test",
              version: "2026-01-01",
              format: "OpenAI",
              lifecycleStatus: "Stable",
              skus: [
                {
                  name: "GlobalStandard",
                  capacity: { minimum: 1, maximum: 10, default: 1, step: 1 },
                },
              ],
            },
          ],
        });
      if (path.endsWith("/usages")) return Response.json({ value: [] });
      if (path.endsWith("/deployments"))
        return Response.json({ value: Object.values(aiDeployments) });
      if (path.includes("/deployments/") && options?.method === "PUT") {
        const name = path.split("/").pop()!;
        aiDeployments[name] = {
          name,
          ...JSON.parse(String(options.body)),
          properties: {
            ...JSON.parse(String(options.body)).properties,
            provisioningState: "Succeeded",
          },
        };
        return Response.json(aiDeployments[name]);
      }
      if (path.includes("/deployments/") && options?.method === "DELETE") {
        delete aiDeployments[path.split("/").pop()!];
        return new Response(null, { status: 204 });
      }
      const service = {
        id: aiRoot,
        name: "test-ai",
        kind: "OpenAI",
        location: "eastasia",
        properties: {
          provisioningState: "Succeeded",
          endpoint: "https://test-ai.openai.azure.com/",
        },
      };
      return Response.json(
        path.endsWith("/accounts") ? { value: [service] } : service,
      );
    }
    if (path.includes("/billingProperty/"))
      return Response.json({
        properties: {
          billingAccountAgreementType: "MicrosoftCustomerAgreement",
          billingProfileId:
            "/providers/Microsoft.Billing/billingAccounts/test/billingProfiles/test",
          billingProfileSpendingLimitDetails: [
            { amount: 100, currency: "USD", status: "Active" },
          ],
        },
      });
    if (path.includes("/balanceSummary"))
      return Response.json({
        properties: {
          balanceSummary: { currentBalance: { value: 76.5, currency: "USD" } },
        },
      });
    if (path.includes("/Microsoft.CostManagement/query"))
      return Response.json({
        properties: {
          columns: [{ name: "PreTaxCost" }, { name: "Currency" }],
          rows: [[23.5, "USD"]],
        },
      });
    if (path.endsWith("/resources"))
      return Response.json({
        value: path.includes("/occupied/")
          ? [{ name: "protected-disk", type: "Microsoft.Compute/disks" }]
          : [],
      });
    if (options?.method === "DELETE")
      return new Response(null, { status: 204 });
    if (String(url).includes("/subscriptions?"))
      return Response.json({ value: account.subscriptions });
    if (String(url).includes("/usages?"))
      return Response.json({
        value: [
          {
            name: { value: "cores", localizedValue: "区域 vCPU 总数" },
            currentValue: 1,
            limit: 4,
          },
        ],
      });
    if (String(url).includes("/locations?"))
      return Response.json({
        value: [
          { name: "eastasia", displayName: "East Asia", metadata: {} },
          { name: "japaneast", displayName: "Japan East", metadata: {} },
        ],
      });
    if (String(url).includes("/artifacttypes/vmimage/offers/"))
      return Response.json({
        value: [{ name: "server" }, { name: "gen1" }],
      });
    if (String(url).includes("/skus?"))
      return Response.json({
        value: [
          {
            name: "Standard_B1s",
            resourceType: "virtualMachines",
            capabilities: [
              { name: "vCPUs", value: "1" },
              { name: "MemoryGB", value: "1" },
              { name: "HyperVGenerations", value: "V1,V2" },
            ],
            restrictions: [],
          },
        ],
      });
    if (String(url).includes("/resourcegroups?"))
      return Response.json({
        value: [
          {
            id: "group-1",
            name: "dev-api-01-azpanel",
            location: "eastasia",
            properties: { provisioningState: "Succeeded" },
          },
        ],
      });
    return Response.json({ value: [] });
  },
  async () => "fake-token",
);
// A separate local, mock-only server exercises write UI against the production build.
const writeConfig = {
  ...testConfig,
  writesEnabled: true,
  avatarSource: "local" as const,
};
const writeStore = new Store(writeConfig, true);
const writeAdmin = writeStore.db
  .prepare("SELECT id FROM users LIMIT 1")
  .get() as { id: string };
writeStore.saveAccount(writeAdmin.id, account, credentials);
const writeAzure = new Azure(
  new RequestGate(0),
  async (url, options) => {
    if (new URL(String(url)).pathname.endsWith("/resourcegroups"))
      return Response.json({
        value: [
          {
            name: "occupied",
            id: "occupied",
            location: "eastasia",
            properties: { provisioningState: "Succeeded" },
          },
          {
            name: "empty",
            id: "empty",
            location: "eastasia",
            properties: { provisioningState: "Succeeded" },
          },
        ],
      });
    // Delegate to the shared mock transport without making an external request.
    const result = await azure.request(
      credentials,
      options?.method ?? "GET",
      String(url),
      options?.body ? JSON.parse(String(options.body)) : undefined,
    );
    return result.status === 204
      ? new Response(null, { status: 204 })
      : Response.json(result.data, {
          status: result.status,
          headers: result.headers,
        });
  },
  async () => "fake-token",
);
const { app: writeApp } = await buildApp(writeConfig, {
  store: writeStore,
  azure: writeAzure,
});
await writeApp.listen({ host: "127.0.0.1", port: 3001 });
const { app } = await buildApp(
  { ...testConfig, avatarSource: "local" },
  { store, azure },
);
await app.listen({ host: "127.0.0.1", port: 3000 });

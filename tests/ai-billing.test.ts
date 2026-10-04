import { test } from "node:test";
import assert from "node:assert/strict";
import { Azure, RequestGate } from "../server/azure.js";
import { AzureAi } from "../server/azure-ai.js";
import { AzureBilling } from "../server/azure-billing.js";
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { aiDeploySchema } from "../shared/ai.js";
import { account, credentials, testConfig } from "./fixtures.js";

const service = { group: "ai-group", name: "ai-service" };
const aiRoot = `/subscriptions/${account.subscriptionId}/resourceGroups/ai-group/providers/Microsoft.CognitiveServices/accounts/ai-service`;
const model = {
  format: "OpenAI",
  name: "gpt-test",
  version: "2026-01-01",
  lifecycleStatus: "Stable",
  skus: [
    {
      name: "GlobalStandard",
      usageName: "gpt-test",
      capacity: { minimum: 2, maximum: 10, step: 2, default: 2 },
    },
  ],
};

test("AI landing needs only service list and deployments; catalog checks share cached verification", async () => {
  const urls: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (url) => {
      const path = new URL(String(url)).pathname;
      urls.push(path);
      if (path.endsWith("/accounts"))
        return Response.json({
          value: [
            {
              id: aiRoot,
              name: service.name,
              kind: "OpenAI",
              location: "eastus",
            },
          ],
        });
      if (path.endsWith("/models")) return Response.json({ value: [model] });
      if (path.endsWith("/deployments") || path.endsWith("/usages"))
        return Response.json({ value: [] });
      throw new Error("Unexpected duplicate service verification");
    },
    async () => "token",
  );
  const ai = new AzureAi(azure);
  await ai.services(credentials, account);
  await ai.deployments(credentials, account, service);
  assert.equal(urls.length, 2);
  await Promise.all([
    ai.models(credentials, account, service),
    ai.usages(credentials, account, service),
  ]);
  assert.equal(urls.length, 4);
  await ai.services(credentials, account);
  await ai.deployments(credentials, account, service);
  await ai.usages(credentials, account, service);
  assert.equal(urls.length, 4);
  await ai.deployments(credentials, account, service, true);
  assert.equal(urls.length, 5);
});

test("AI capacity explicitly distinguishes Azure defaults from minimum and fallback values", async () => {
  const azure = new Azure(
    new RequestGate(0),
    async (url) =>
      String(url).includes("/models?")
        ? Response.json({
            value: [
              {
                ...model,
                skus: [
                  { name: "Default", capacity: { minimum: 1, default: 5 } },
                  { name: "MinOnly", capacity: { minimum: 10 } },
                  { name: "Neither" },
                ],
              },
            ],
          })
        : Response.json({ kind: "OpenAI" }),
    async () => "token",
  );
  const skus = (
    await new AzureAi(azure).models(credentials, account, service)
  )[0].skus;
  assert.deepEqual(
    skus.map((sku) => [sku.default, sku.azureDefault, sku.defaultSource]),
    [
      [5, 5, "azure"],
      [10, null, "minimum"],
      [1, null, "fallback"],
    ],
  );
});

test("AI models use the service catalog, validate capacity, preserve chosen version, and delete only a deployment", async () => {
  const requests: { url: string; method: string; body: any }[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (input, options) => {
      const url = String(input),
        method = options!.method!;
      requests.push({
        url,
        method,
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      });
      if (method === "PUT")
        return Response.json({
          properties: { provisioningState: "Succeeded" },
        });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/models?")) return Response.json({ value: [model] });
      if (url.includes("/deployments?")) return Response.json({ value: [] });
      return Response.json({ kind: "OpenAI", location: "eastus" });
    },
    async () => "token",
  );
  const ai = new AzureAi(azure);
  assert.equal(
    (await ai.models(credentials, account, service))[0].skus[0].step,
    2,
  );
  const before = requests.length;
  await ai.models(credentials, account, service);
  assert.equal(requests.length, before);
  const input = aiDeploySchema.parse({
    ...service,
    deployment: "chat-test",
    confirmation: "chat-test",
    model: { format: model.format, name: model.name, version: model.version },
    sku: "GlobalStandard",
    capacity: 3,
  });
  await assert.rejects(
    ai.deploy(credentials, account, input, () => {}),
    /容量/,
  );
  await assert.rejects(
    ai.deploy(
      credentials,
      account,
      { ...input, capacity: 2, sku: "ImaginarySku" },
      () => {},
    ),
    /部署类型/,
  );
  await ai.deploy(credentials, account, { ...input, capacity: 2 }, () => {});
  const put = requests.find((request) => request.method === "PUT")!;
  assert.ok(put.url.includes(`${aiRoot}/deployments/chat-test?`));
  assert.deepEqual(put.body.properties.model, input.model);
  assert.deepEqual(put.body.sku, { name: "GlobalStandard", capacity: 2 });
  await ai.deleteDeployment(
    credentials,
    account,
    service,
    "chat-test",
    () => {},
  );
  const countBeforeRefresh = requests.filter((item) =>
    item.url.includes("/deployments?"),
  ).length;
  await ai.deployments(credentials, account, service);
  assert.equal(
    requests.filter((item) => item.url.includes("/deployments?")).length,
    countBeforeRefresh + 1,
    "deleting a deployment must invalidate its cached list",
  );
  assert.ok(
    requests
      .find((request) => request.method === "DELETE")!
      .url.includes("/deployments/chat-test?"),
  );
  assert.throws(() =>
    aiDeploySchema.parse({
      ...input,
      group: "../other",
      confirmation: "wrong",
    }),
  );
});

test("AI create does not overwrite existing Cognitive Services accounts", async () => {
  const methods: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (_input, options) => {
      methods.push(options!.method!);
      return Response.json({ kind: "OtherService" });
    },
    async () => "token",
  );
  await assert.rejects(
    new AzureAi(azure).createService(
      credentials,
      account,
      {
        ...service,
        location: "eastus",
        kind: "OpenAI",
        confirmation: service.name,
      },
      () => {},
    ),
    /已存在/,
  );
  assert.ok(methods.every((method) => method === "GET"));
});

test("AI service creation uses a selected group, kind and S0 with no account key retrieval", async () => {
  const requests: { url: string; method: string; body: any }[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (url, options) => {
      requests.push({
        url: String(url),
        method: options!.method!,
        body: options?.body ? JSON.parse(String(options.body)) : null,
      });
      if (
        options?.method === "GET" &&
        String(url).includes("/accounts/ai-service?")
      )
        return Response.json(
          { error: { code: "ResourceNotFound" } },
          { status: 404 },
        );
      if (String(url).includes("/providers/Microsoft.CognitiveServices?"))
        return Response.json({ registrationState: "Registered" });
      return Response.json({ properties: { provisioningState: "Succeeded" } });
    },
    async () => "token",
  );
  await new AzureAi(azure).createService(
    credentials,
    account,
    {
      ...service,
      kind: "AIServices",
      location: "eastus",
      confirmation: service.name,
    },
    () => {},
  );
  const writes = requests.filter((item) => item.method !== "GET");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.sku, { name: "S0" });
  assert.equal(writes[0].body.kind, "AIServices");
  assert.equal(writes[0].body.properties.customSubDomainName, service.name);
  assert.ok(requests.every((item) => !item.url.includes("listKeys")));
});

test("AI write routes reject another user before any cloud request", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true);
  let cloudCalls = 0;
  const { app } = await buildApp(config, {
    store,
    azure: new Azure(
      new RequestGate(0),
      async () => {
        cloudCalls++;
        return Response.json({});
      },
      async () => "token",
    ),
  });
  try {
    const admin = store.db.prepare("SELECT id FROM users LIMIT 1").get() as {
      id: string;
    };
    store.saveAccount(admin.id, account, credentials);
    const other = store.createUser(
      "ai-writer@example.test",
      "OtherWriter-password",
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: other.email, password: "OtherWriter-password" },
    });
    const headers = {
      cookie: "azpanel_session=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrf,
    };
    for (const method of ["POST", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: `/api/accounts/${account.id}/ai/deployments`,
        headers,
        payload: { ...service, deployment: "owned", confirmation: "owned" },
      });
      assert.equal(response.statusCode, 404);
    }
    assert.equal(cloudCalls, 0);
    assert.equal(store.tasks(other.id).length, 0);
  } finally {
    await app.close();
  }
});

test("billing preserves currency and zero balance, marks shared profile, handles paginated costs", async () => {
  let costs = 0;
  const profile =
    "/providers/Microsoft.Billing/billingAccounts/test/billingProfiles/test";
  const azure = new Azure(
    new RequestGate(0),
    async (input) => {
      const url = String(input);
      if (url.includes("billingProperty"))
        return Response.json({
          properties: {
            billingAccountAgreementType: "MicrosoftCustomerAgreement",
            billingProfileId: profile,
            billingProfileSpendingLimitDetails: [
              { status: "Active", amount: 100, currency: "USD" },
            ],
          },
        });
      if (url.includes("balanceSummary"))
        return Response.json({
          properties: {
            isEstimatedBalance: false,
            balanceSummary: { currentBalance: { value: 0, currency: "USD" } },
          },
        });
      costs++;
      return Response.json({
        properties: {
          columns: [{ name: "Currency" }, { name: "PreTaxCost" }],
          rows:
            costs === 1
              ? [["USD", 2.5]]
              : [
                  ["USD", 1.5],
                  ["EUR", 3],
                ],
          nextLink:
            costs === 1
              ? `https://management.azure.com/subscriptions/${account.subscriptionId}/providers/Microsoft.CostManagement/query?page=2`
              : null,
        },
      });
    },
    async () => "token",
  );
  const summary = await new AzureBilling(azure).summary(credentials, account);
  assert.equal(summary.credit.scope, "billingProfile");
  assert.deepEqual(summary.credit.remaining, { value: 0, currency: "USD" });
  assert.deepEqual(summary.credit.total, { value: 100, currency: "USD" });
  assert.deepEqual(summary.spending.amounts, [
    { currency: "USD", value: 4 },
    { currency: "EUR", value: 3 },
  ]);
});

test("billing never invents a student credit balance and reports denied/unsupported APIs", async () => {
  const azure = new Azure(
    new RequestGate(0),
    async (input) =>
      String(input).includes("billingProperty")
        ? Response.json({
            properties: {
              billingAccountAgreementType: "MicrosoftOnlineServicesProgram",
            },
          })
        : Response.json(
            { error: { code: "AuthorizationFailed" } },
            { status: 403 },
          ),
    async () => "token",
  );
  const summary = await new AzureBilling(azure).summary(credentials, account);
  assert.equal(summary.credit.status, "unsupported");
  assert.equal(summary.credit.remaining, null);
  assert.equal(summary.credit.total, null);
  assert.equal(summary.spending.status, "forbidden");
  assert.deepEqual(summary.spending.amounts, []);
});

test("AI and billing APIs enforce ownership/write mode and persist cache", async () => {
  const store = new Store(testConfig, true),
    calls: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (input) => {
      calls.push(String(input));
      return Response.json(
        { error: { code: "NotSupported" } },
        { status: 404 },
      );
    },
    async () => "token",
  );
  const { app } = await buildApp(testConfig, { store, azure });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: {
        email: testConfig.adminEmail,
        password: testConfig.adminPassword,
      },
    });
    const owner = login.json().user.id,
      headers = {
        cookie: "azpanel_session=" + login.cookies[0].value,
        "x-csrf-token": login.json().csrf,
      };
    store.saveAccount(owner, account, credentials);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await app.inject({
            url: `/api/accounts/${account.id}/billing`,
            headers,
          })
        ).statusCode,
        200,
      );
    assert.equal(calls.length, 2);
    assert.ok(
      store.db
        .prepare("SELECT data FROM billing_cache WHERE account_id=?")
        .get(account.id),
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/ai/deployments`,
          headers,
          payload: {},
        })
      ).statusCode,
      403,
    );
    const other = store.createUser(
      "ai-other@example.test",
      "OtherPassword-123",
    );
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: other.email, password: "OtherPassword-123" },
    });
    const otherHeaders = {
      cookie: "azpanel_session=" + otherLogin.cookies[0].value,
    };
    for (const suffix of [
      "billing",
      "ai/services",
      "ai/models?group=ai-group&name=ai-service",
      "ai/deployments?group=ai-group&name=ai-service",
    ]) {
      assert.equal(
        (
          await app.inject({
            url: `/api/accounts/${account.id}/${suffix}`,
            headers: otherHeaders,
          })
        ).statusCode,
        404,
      );
    }
    assert.equal(calls.length, 2);
  } finally {
    await app.close();
  }
});

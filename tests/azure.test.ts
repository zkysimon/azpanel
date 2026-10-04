import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Azure,
  RequestGate,
  armUrl,
  capabilities,
  deploymentTemplate,
  powerState,
  selectSubscription,
} from "../server/azure.js";
import { createVmSchema } from "../shared/validation.js";
import { selectGen2Skus } from "../shared/images.js";
import {
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
} from "../server/security.js";
import { credentials, testConfig } from "./fixtures.js";

const response = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
test("ARM lists follow nextLink and refuse cross-origin token leakage", async () => {
  const urls: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (input) => {
      urls.push(String(input));
      return urls.length === 1
        ? response({
            value: [{ id: 1 }],
            nextLink: "https://management.azure.com/page2",
          })
        : response({ value: [{ id: 2 }] });
    },
    async () => "fake-token",
  );
  assert.deepEqual(await azure.list(credentials, "/page1"), [
    { id: 1 },
    { id: 2 },
  ]);
  assert.equal(urls.length, 2);
  for (const url of [
    "https://example.test/path",
    "//example.test/path",
    "http://management.azure.com/",
    "https://user@management.azure.com/",
  ])
    assert.throws(() => armUrl(url));
  const hostile = new Azure(
    new RequestGate(0),
    async () => response({ value: [], nextLink: "https://evil.test/" }),
    async () => "secret-token",
  );
  await assert.rejects(hostile.list(credentials, "/page1"), /无效/);
});
test("partial pagination failure rejects the entire snapshot", async () => {
  let count = 0;
  const azure = new Azure(
    new RequestGate(0),
    async () =>
      ++count === 1
        ? response({ value: [{ id: 1 }], nextLink: "/two" })
        : response({ error: { code: "AuthorizationFailed" } }, 403),
    async () => "token",
  );
  await assert.rejects(azure.list(credentials, "/one"), /权限不足/);
});
test("provisioning follows Azure-AsyncOperation; failed operation is not reported as success", async () => {
  const requests: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (url, options) => {
      requests.push(options!.method + " " + String(url));
      if (requests.length === 1)
        return response({ id: "/resource" }, 201, {
          "Azure-AsyncOperation": "/operations/1",
          "Retry-After": "0",
        });
      return response({ status: "Failed", error: { code: "QuotaExceeded" } });
    },
    async () => "token",
  );
  await assert.rejects(
    azure.operation(credentials, "PUT", "/resource", {}),
    /QuotaExceeded/,
  );
  assert.equal(requests.length, 2);
});
test("a failed write is never automatically resubmitted", async () => {
  let calls = 0;
  const azure = new Azure(
    new RequestGate(0),
    async () => {
      calls++;
      return response({ error: { code: "TooManyRequests" } }, 429);
    },
    async () => "token",
  );
  await assert.rejects(azure.request(credentials, "POST", "/action"), /限流/);
  assert.equal(calls, 1);
});
test("subscription selection handles empty, disabled-first, and explicitly chosen subscriptions", () => {
  const subscriptions = [
    { subscriptionId: "one", displayName: "one", state: "Disabled" },
    { subscriptionId: "two", displayName: "two", state: "Enabled" },
  ];
  assert.equal(selectSubscription(subscriptions).subscriptionId, "two");
  assert.equal(selectSubscription(subscriptions, "one").state, "Disabled");
  assert.throws(() => selectSubscription([]), /没有可访问/);
  assert.throws(() => selectSubscription(subscriptions, "missing"), /无法访问/);
});
test("power state and SKU capabilities are independent of array ordering", () => {
  assert.equal(
    powerState({
      statuses: [
        { code: "PowerState/running" },
        { code: "ProvisioningState/succeeded" },
      ],
    }),
    "running",
  );
  assert.equal(powerState({}), "unknown");
  assert.deepEqual(
    capabilities({
      capabilities: [
        { name: "MemoryGB", value: "8" },
        { name: "vCPUs", value: "2" },
      ],
    }),
    { MemoryGB: "8", vCPUs: "2" },
  );
});
test("credentials use authenticated encryption and password hashes are salted", () => {
  const encoded = encrypt(credentials, testConfig.encryptionKey);
  assert.equal(encoded.includes(credentials.password), false);
  assert.deepEqual(decrypt(encoded, testConfig.encryptionKey), credentials);
  assert.throws(() => decrypt(encoded, "cd".repeat(32)));
  const password = "An-example-password";
  const hash = hashPassword(password);
  assert.notEqual(hash, hashPassword(password));
  assert.ok(verifyPassword(password, hash));
  assert.ok(!verifyPassword("wrong", hash));
});
test("deployment uses static Standard IPs, explicit dependencies, restricted ingress and secureString password", () => {
  const input = createVmSchema.parse({
    name: "test-vm",
    confirmation: "test-vm",
    location: "eastus",
    size: "Standard_B1s",
    image: {
      publisher: "Canonical",
      offer: "ubuntu-24_04-lts",
      sku: "server",
      version: "latest",
    },
    diskSize: 30,
    username: "azureuser",
    authentication: "password",
    password: "TestOnly!Password123",
    allowedSource: "203.0.113.1/32",
    ipv6: true,
  });
  const { template, parameters } = deploymentTemplate(input);
  const vm = template.resources.find(
    (resource) => resource.type === "Microsoft.Compute/virtualMachines",
  )!;
  assert.deepEqual(vm.properties.storageProfile.imageReference, {
    publisher: "Canonical",
    offer: "ubuntu-24_04-lts",
    sku: "server",
    version: "latest",
  });
  assert.ok(!JSON.stringify(template).includes(input.password));
  assert.equal(parameters.adminPassword?.value, input.password);
  const ips = template.resources.filter(
    (resource) => resource.type === "Microsoft.Network/publicIPAddresses",
  );
  assert.equal(ips.length, 2);
  assert.ok(
    ips.every(
      (resource) =>
        resource.sku.name === "Standard" &&
        resource.properties.publicIPAllocationMethod === "Static",
    ),
  );
  const nic = template.resources.find(
    (resource) => resource.type === "Microsoft.Network/networkInterfaces",
  )!;
  assert.equal(nic.dependsOn.length, 4);
  assert.ok(nic.properties.networkSecurityGroup.id);
  const nsg = template.resources.find(
    (resource) => resource.type === "Microsoft.Network/networkSecurityGroups",
  )!;
  assert.equal(
    nsg.properties.securityRules[0].properties.sourceAddressPrefix,
    "203.0.113.1/32",
  );
  assert.throws(() =>
    createVmSchema.parse({ ...input, confirmation: "wrong" }),
  );
  assert.throws(() =>
    createVmSchema.parse({ ...input, allowedSource: "999.1.1.1/999" }),
  );
});
test("SKU filter keeps Gen2 x64 images and drops Gen1/arm64", () => {
  assert.deepEqual(selectGen2Skus(["server", "server-gen1", "minimal-arm64"]), [
    "server",
  ]);
  assert.deepEqual(selectGen2Skus(["22_04-lts", "22_04-lts-gen2"]), [
    "22_04-lts-gen2",
  ]);
  assert.deepEqual(
    selectGen2Skus(["2022-datacenter-g2", "2019-datacenter-g2"]),
    ["2022-datacenter-g2", "2019-datacenter-g2"],
  );
});

test("image listing reads SKUs live from Azure and skips regions without a publisher", async () => {
  const requested: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (url) => {
      requested.push(String(url));
      if (String(url).includes("debian-12"))
        return response([{ name: "12-gen2" }, { name: "12-gen1" }]);
      if (String(url).includes("WindowsServer"))
        return response([{ name: "2022-datacenter-smalldisk-g2" }]);
      return response({ error: { code: "NotFound" } }, 404);
    },
    async () => "token",
  );
  const { account } = await import("./fixtures.js");
  const options = await azure.imageOptions(credentials, account, "eastus");
  assert.ok(
    options.every((option) => !/gen1|arm64/i.test(option.sku)),
    "Gen1/arm64 SKUs must be filtered out",
  );
  assert.deepEqual(
    options.map((option) => option.label),
    ["Debian 12 · 12-gen2", "Windows Server · 2022-datacenter-smalldisk-g2"],
  );
  assert.equal(
    options.find((option) => option.family === "Windows Server")?.osType,
    "Windows",
  );
  assert.equal(
    options.find((option) => option.family === "Debian 12")?.osType,
    "Linux",
  );
  const requestsBefore = requested.length;
  await azure.imageOptions(credentials, account, "eastus");
  assert.equal(requested.length, requestsBefore, "second call must hit cache");
});

test("request gate serializes concurrent requests", async () => {
  const gate = new RequestGate(10),
    order: string[] = [];
  await Promise.all([
    gate.run(async () => {
      order.push("a");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("b");
    }),
    gate.run(async () => {
      order.push("c");
    }),
  ]);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("DELETE without a polling URL waits until the resource actually disappears", async () => {
  let calls = 0;
  const azure = new Azure(
    new RequestGate(0),
    async () => {
      calls++;
      if (calls === 1) return response({}, 202, { "Retry-After": "0" });
      if (calls === 2)
        return response(
          { properties: { provisioningState: "Succeeded" } },
          200,
          { "Retry-After": "0" },
        );
      return response({ error: { code: "ResourceGroupNotFound" } }, 404);
    },
    async () => "token",
  );
  await azure.operation(credentials, "DELETE", "/resource");
  assert.equal(calls, 3);
});

test("concurrent cached reads share one Azure request", async () => {
  let calls = 0;
  const azure = new Azure(
    new RequestGate(0),
    async () => {
      calls++;
      return response({ value: [] });
    },
    async () => "token",
  );
  const { account } = await import("./fixtures.js");
  await Promise.all([
    azure.quotas(credentials, account, "eastus"),
    azure.quotas(credentials, account, "eastus"),
  ]);
  assert.equal(calls, 1);
});

test("write errors never expose echoed passwords or template secrets", async () => {
  const secret = "VmSecret-NotForLogs";
  const azure = new Azure(
    new RequestGate(0),
    async () =>
      response(
        { error: { code: "BadRequest", message: `bad template ${secret}` } },
        400,
      ),
    async () => "token",
  );
  await assert.rejects(
    azure.request(credentials, "PUT", "/deployment", { password: secret }),
    (error) => error instanceof Error && !error.message.includes(secret),
  );
});

test("operation polling recovers from transient network failure without repeating DELETE", async () => {
  const calls: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (_url, options) => {
      calls.push(options!.method!);
      if (calls.length === 1)
        return response({}, 202, {
          Location: "/operations/delete",
          "Retry-After": "0",
        });
      if (calls.length === 2) throw new TypeError("fetch failed");
      return response({ status: "Succeeded" });
    },
    async () => "token",
  );
  await azure.operation(credentials, "DELETE", "/resource");
  assert.deepEqual(calls, ["DELETE", "GET", "GET"]);
});

test("ambiguous network failure on a write is not retried", async () => {
  let calls = 0;
  const azure = new Azure(
    new RequestGate(0),
    async () => {
      calls++;
      throw new TypeError("fetch failed");
    },
    async () => "token",
  );
  await assert.rejects(
    azure.request(credentials, "POST", "/resource/restart"),
    /超时或连接失败/,
  );
  assert.equal(calls, 1);
});

test("avatar URLs hash the email and honor the configured source", async () => {
  const { avatarUrl, avatarTint } = await import("../server/avatar.js");
  const url = avatarUrl("Person@Example.com", "gravatar")!;
  assert.match(url, /^https:\/\/www\.gravatar\.com\/avatar\/[a-f0-9]{64}\?/);
  assert.ok(!url.includes("person"), "the email itself must never appear");
  // Case/whitespace normalisation yields a stable hash.
  assert.equal(
    avatarUrl("  person@example.com  ", "gravatar"),
    avatarUrl("PERSON@EXAMPLE.COM", "gravatar"),
  );
  assert.equal(avatarUrl("a@b.co", "local"), null);
  assert.equal(avatarUrl("a@b.co", "none"), null);
  assert.equal(avatarTint("a@b.co"), avatarTint("A@B.CO"));
  assert.ok(avatarTint("a@b.co") >= 0 && avatarTint("a@b.co") < 6);
});

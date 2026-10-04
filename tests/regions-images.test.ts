import { test } from "node:test";
import assert from "node:assert/strict";
import { Azure, RequestGate } from "../server/azure.js";
import { deploymentTemplate } from "../server/azure.js";
import { createVmSchema } from "../shared/validation.js";
import { account, credentials } from "./fixtures.js";

const image = {
  publisher: "Canonical",
  offer: "ubuntu-24_04-lts",
  sku: "server",
  version: "latest",
};
test("regions exclude Logical/unknown entries and group physical regions by continent", async () => {
  const azure = new Azure(
    new RequestGate(0),
    async () =>
      Response.json({
        value: [
          {
            name: "asia",
            displayName: "Asia",
            metadata: { regionType: "Logical", geographyGroup: "Asia Pacific" },
          },
          { name: "global", displayName: "Global" },
          {
            name: "australiaeast",
            displayName: "Australia East",
            metadata: {
              regionType: "Physical",
              geographyGroup: "Asia Pacific",
              geography: "Australia",
            },
          },
          {
            name: "japaneast",
            displayName: "Japan East",
            metadata: {
              regionType: "Physical",
              geographyGroup: "Asia Pacific",
              geography: "Japan",
            },
          },
          {
            name: "francecentral",
            displayName: "France Central",
            metadata: {
              regionType: "Physical",
              geographyGroup: "Europe",
              geography: "France",
            },
          },
          {
            name: "eastasia",
            displayName: "East Asia",
            metadata: {
              regionType: "Physical",
              geographyGroup: "Asia Pacific",
              geography: "Asia Pacific",
            },
          },
          {
            name: "edge",
            displayName: "Edge",
            metadata: { regionType: "EdgeZone" },
          },
        ],
      }),
    async () => "token",
  );
  const regions = await azure.locations(credentials, account);
  assert.deepEqual(
    regions.map((item) => item.name),
    ["eastasia", "japaneast", "francecentral", "australiaeast"],
  );
  assert.deepEqual(
    regions.map((item) => item.continent),
    ["亚洲", "亚洲", "欧洲", "大洋洲"],
  );
});

test("image validation resolves a bare version array then GETs the specific image version", async () => {
  const urls: URL[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (url) => {
      const value = new URL(String(url));
      urls.push(value);
      if (value.pathname.endsWith("/versions"))
        return Response.json([{ name: "24.04.202609040" }]);
      if (value.pathname.endsWith("/versions/24.04.202609040"))
        return Response.json({
          properties: {
            architecture: "x64",
            hyperVGeneration: "V2",
            osDiskImage: { sizeInGb: 30 },
          },
        });
      return Response.json(
        {
          error: {
            code: "BadRequest",
            message: "The request URL is not valid.",
          },
        },
        { status: 400 },
      );
    },
    async () => "token",
  );
  const result = await azure.assertImageAvailable(
    credentials,
    account,
    "eastasia",
    image,
  );
  assert.equal(result.reference.version, "24.04.202609040");
  assert.equal(urls[0].searchParams.get("$orderby"), "name desc");
  assert.equal(urls[0].searchParams.get("$top"), "1");
  assert.equal(urls.length, 2);
  const input = createVmSchema.parse({
    name: "testvm",
    confirmation: "testvm",
    location: "eastasia",
    size: "Standard_B1s",
    image: result.reference,
    username: "azureuser",
    diskSize: 30,
    authentication: "password",
    password: "Synthetic123!Password",
    allowedSource: "192.0.2.1/32",
  });
  const vm = deploymentTemplate(input).template.resources.find(
    (item) => item.type === "Microsoft.Compute/virtualMachines",
  )!;
  assert.equal(
    vm.properties.storageProfile.imageReference.version,
    "24.04.202609040",
  );
});

test("no versions and malformed image catalogs reject before deployment", async () => {
  for (const response of [[], { value: [] }]) {
    let writes = 0;
    const azure = new Azure(
      new RequestGate(0),
      async (_url, options) => {
        if (options?.method !== "GET") writes++;
        return Response.json(response);
      },
      async () => "token",
    );
    await assert.rejects(
      azure.assertImageAvailable(credentials, account, "eastasia", image),
      /没有可用版本|响应格式/,
    );
    assert.equal(writes, 0);
  }
});

test("explicit image versions are preserved without querying latest", async () => {
  const urls: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (url) => {
      urls.push(String(url));
      return Response.json({
        properties: {
          hyperVGeneration: "V2",
          architecture: "x64",
          osDiskImage: { sizeInGb: 30 },
        },
      });
    },
    async () => "token",
  );
  const result = await azure.assertImageAvailable(
    credentials,
    account,
    "eastasia",
    { ...image, version: "24.04.202601010" },
  );
  assert.equal(result.reference.version, "24.04.202601010");
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/versions\/24\.04\.202601010\?/);
});

test("logical regions cannot trigger VM creation even with syntactically valid input", async () => {
  const requests: string[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (_url, options) => {
      requests.push(options!.method!);
      return Response.json({
        value: [
          {
            name: "asia",
            displayName: "Asia",
            metadata: { regionType: "Logical" },
          },
        ],
      });
    },
    async () => "token",
  );
  const input = createVmSchema.parse({
    name: "testvm",
    confirmation: "testvm",
    location: "asia",
    size: "Standard_B1s",
    image,
    username: "azureuser",
    diskSize: 30,
    authentication: "password",
    password: "Synthetic123!Password",
    allowedSource: "192.0.2.1/32",
  });
  await assert.rejects(
    azure.create(credentials, account, input, () => {}),
    /实体部署区域/,
  );
  assert.deepEqual(requests, ["GET"]);
});

test("cache invalidation prevents in-flight stale reads from repopulating cache after a write", async () => {
  const azure = new Azure(new RequestGate(0));
  let release: (value: string) => void = () => {};
  const old = azure.cached(
    "test",
    60000,
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  azure.invalidateCache("test");
  assert.equal(await azure.cached("test", 60000, async () => "new"), "new");
  release("old");
  await old;
  assert.equal(
    await azure.cached("test", 60000, async () => "unexpected"),
    "new",
  );
});

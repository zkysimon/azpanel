import { test } from "node:test";
import assert from "node:assert/strict";
import { Azure, RequestGate } from "../server/azure.js";
import { createVmSchema } from "../shared/validation.js";
import { account, credentials, providerMetadata } from "./fixtures.js";

test("creation checks availability and group collision before submitting dependency-managed deployment", async () => {
  const requests: { method: string; url: string; body: any }[] = [];
  const azure = new Azure(
    new RequestGate(0),
    async (url, options) => {
      const path = String(url);
      requests.push({
        method: options!.method!,
        url: path,
        body: options!.body ? JSON.parse(String(options!.body)) : null,
      });
      if (path.includes("/locations?"))
        return Response.json({
          value: [
            {
              name: "eastus",
              displayName: "East US",
              metadata: {
                regionType: "Physical",
                geographyGroup: "North America",
              },
            },
          ],
        });
      if (path.includes("/versions?"))
        return Response.json([{ name: "24.04.202609040" }]);
      if (path.includes("/versions/24.04.202609040?"))
        return Response.json({
          properties: {
            hyperVGeneration: "V2",
            architecture: "x64",
            osDiskImage: { sizeInGb: 30 },
          },
        });
      if (path.includes("/artifacttypes/"))
        throw new Error(`Unexpected image API: ${path}`);
      if (path.includes("/skus?"))
        return Response.json({
          value: [
            {
              resourceType: "virtualMachines",
              name: "Standard_B1s",
              capabilities: [
                { name: "vCPUs", value: "1" },
                { name: "MemoryGB", value: "1" },
                { name: "HyperVGenerations", value: "V1,V2" },
              ],
              restrictions: [],
            },
          ],
        });
      if (path.includes("/resourcegroups?"))
        return Response.json({ value: [] });
      if (
        path.includes("/providers/Microsoft.Compute?") ||
        path.includes("/providers/Microsoft.Network?")
      )
        return Response.json(
          providerMetadata(new URL(path).pathname.split("/").pop()!),
        );
      return Response.json({ properties: { provisioningState: "Succeeded" } });
    },
    async () => "token",
  );
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
  });
  await azure.create(credentials, account, input, () => {});
  const writes = requests.filter((request) => request.method !== "GET");
  assert.equal(writes.length, 3);
  assert.equal(writes[0].method, "PUT");
  assert.ok(writes[1].url.includes("/validate?"));
  assert.ok(
    writes[2].body.properties.template.resources.some(
      (resource: any) => resource.type === "Microsoft.Compute/virtualMachines",
    ),
  );
  assert.equal(
    writes[2].body.properties.template.resources.find(
      (resource: any) => resource.type === "Microsoft.Compute/virtualMachines",
    ).properties.storageProfile.imageReference.version,
    "24.04.202609040",
  );
  assert.ok(
    !JSON.stringify(writes[2].body.properties.template).includes(
      input.password,
    ),
  );
  const start = requests.length;
  await azure.create(
    credentials,
    account,
    {
      ...input,
      name: "ipv6-vm",
      confirmation: "ipv6-vm",
      publicIpv4: false,
      ipv6: true,
    },
    () => {},
  );
  const v6Writes = requests
    .slice(start)
    .filter((request) => request.method !== "GET");
  assert.equal(v6Writes.length, 3);
  for (const write of v6Writes.slice(1)) {
    const ips = write.body.properties.template.resources.filter(
      (resource: any) =>
        resource.type === "Microsoft.Network/publicIPAddresses",
    );
    assert.equal(
      ips.length,
      1,
      "both validation and deployment must omit public IPv4",
    );
    assert.equal(ips[0].properties.publicIPAddressVersion, "IPv6");
  }
});

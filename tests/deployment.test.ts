import { test } from "node:test";
import assert from "node:assert/strict";
import { Azure, RequestGate } from "../server/azure.js";
import { createVmSchema } from "../shared/validation.js";
import { account, credentials } from "./fixtures.js";

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
        return Response.json({ registrationState: "Registered" });
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
    allowedSource: "203.0.113.1/32",
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
  assert.ok(
    !JSON.stringify(writes[2].body.properties.template).includes(
      input.password,
    ),
  );
});

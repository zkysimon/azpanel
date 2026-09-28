// Isolated in-memory database, synthetic credentials, no external Azure requests.
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { Azure, RequestGate } from "../server/azure.js";
import { account, credentials, machine, testConfig } from "./fixtures.js";

const store = new Store(testConfig, true);
const admin = store.db.prepare("SELECT id FROM users LIMIT 1").get() as {
  id: string;
};
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
  async (url) => {
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
const { app } = await buildApp(testConfig, { store, azure });
await app.listen({ host: "127.0.0.1", port: 3000 });

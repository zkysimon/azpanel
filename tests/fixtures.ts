import type { Account, Credentials, VirtualMachine } from "../shared/types.js";
import type { Config } from "../server/config.js";

export const testConfig: Config = {
  encryptionKey: "ab".repeat(32),
  dataDir: "test-results/data",
  host: "127.0.0.1",
  port: 3000,
  adminEmail: "admin@example.test",
  adminPassword: "TestOnly-Password-2026",
  writesEnabled: false,
  cookieSecure: false,
  azureInterval: 0,
  avatarSource: "gravatar",
};
export const credentials: Credentials = {
  appId: "00000000-0000-4000-8000-000000000001",
  tenant: "00000000-0000-4000-8000-000000000002",
  password: "Synthetic-test-secret-only",
};
export const account: Account = {
  id: "00000000-0000-4000-8000-000000000003",
  label: "开发工作空间",
  appId: credentials.appId,
  tenant: credentials.tenant,
  subscriptionId: "00000000-0000-4000-8000-000000000004",
  subscriptionName: "Azure for Students",
  state: "Enabled",
  subscriptions: [
    {
      subscriptionId: "00000000-0000-4000-8000-000000000004",
      displayName: "Azure for Students",
      state: "Enabled",
    },
  ],
  lastSync: Date.now() - 3600000,
  createdAt: Date.now() - 86400000,
  error: null,
};
export const machine: VirtualMachine = {
  id: "test-vm-id",
  accountId: account.id,
  accountLabel: account.label,
  name: "dev-api-01",
  resourceGroup: "dev-api-01-azpanel",
  location: "eastasia",
  size: "Standard_B1s",
  os: "Linux",
  powerState: "running",
  provisioningState: "Succeeded",
  publicIps: ["203.0.113.42"],
  privateIps: ["10.42.0.4"],
  diskSize: 30,
  tags: { managedBy: "azpanel" },
  syncedAt: Date.now(),
  resourceId: `/subscriptions/${account.subscriptionId}/resourceGroups/dev-api-01-azpanel/providers/Microsoft.Compute/virtualMachines/dev-api-01`,
};

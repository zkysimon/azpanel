import { test } from "node:test";
import assert from "node:assert/strict";
import { Azure, RequestGate, deploymentTemplate } from "../server/azure.js";
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { createVmSchema, vmSettingsSchema } from "../shared/validation.js";
import { account, credentials, testConfig } from "./fixtures.js";

const settings = {
  location: "eastasia",
  size: "Standard_B1s",
  image: {
    publisher: "Canonical",
    offer: "ubuntu-24_04-lts",
    sku: "server",
    version: "latest",
  },
  diskSize: 128,
  username: "azureuser",
  authentication: "password",
  password: "TestOnly!Password123",
};

test("all public IP modes preserve private IPv4 and use only the requested public IP resources", () => {
  for (const windows of [false, true]) {
    for (const mode of [
      { publicIpv4: true, ipv6: false, versions: ["IPv4"] },
      { publicIpv4: true, ipv6: true, versions: ["IPv4", "IPv6"] },
      { publicIpv4: false, ipv6: true, versions: ["IPv6"] },
    ]) {
      const input = createVmSchema.parse({
        ...settings,
        ...mode,
        ...(windows
          ? {
              image: {
                publisher: "MicrosoftWindowsServer",
                offer: "WindowsServer",
                sku: "2022-datacenter-g2",
                version: "latest",
              },
            }
          : {}),
        name: "network-vm",
        confirmation: "network-vm",
      });
      const { template } = deploymentTemplate(input);
      const ips = template.resources.filter(
        (item) => item.type === "Microsoft.Network/publicIPAddresses",
      );
      assert.deepEqual(
        ips.map((item) => item.properties.publicIPAddressVersion).sort(),
        [...mode.versions].sort(),
      );
      assert.ok(
        ips.every(
          (item) =>
            item.sku.name === "Standard" &&
            item.properties.publicIPAllocationMethod === "Static",
        ),
      );
      const nic = template.resources.find(
        (item) => item.type === "Microsoft.Network/networkInterfaces",
      )!;
      const configs = nic.properties.ipConfigurations;
      assert.equal(configs.length, mode.ipv6 ? 2 : 1);
      assert.equal(configs[0].properties.primary, true);
      assert.equal(configs[0].properties.privateIPAddressVersion, "IPv4");
      assert.equal(!!configs[0].properties.publicIPAddress, mode.publicIpv4);
      assert.equal(nic.dependsOn.length, 2 + mode.versions.length);
      for (const ip of ips) {
        const id = `[resourceId('Microsoft.Network/publicIPAddresses', '${ip.name}')]`;
        assert.ok(nic.dependsOn.includes(id));
        assert.ok(
          configs.some(
            (config: any) => config.properties.publicIPAddress?.id === id,
          ),
        );
      }
      const vnet = template.resources.find(
        (item) => item.type === "Microsoft.Network/virtualNetworks",
      )!;
      assert.equal(
        vnet.properties.addressSpace.addressPrefixes.length,
        mode.ipv6 ? 2 : 1,
      );
      assert.equal(
        vnet.properties.subnets[0].properties.defaultOutboundAccess,
        false,
      );
      if (mode.ipv6) {
        assert.equal(configs[1].properties.primary, false);
        assert.equal(configs[1].properties.privateIPAddressVersion, "IPv6");
        assert.ok(
          vnet.properties.subnets[0].properties.addressPrefixes.some(
            (prefix: string) => prefix.endsWith("/64"),
          ),
        );
      }
      assert.equal(
        template.resources.some((item) =>
          /natGateways|loadBalancers/.test(item.type),
        ),
        false,
      );
      const rule = template.resources.find(
        (item) => item.type === "Microsoft.Network/networkSecurityGroups",
      )!.properties.securityRules[0].properties;
      assert.equal(rule.protocol, "*");
      assert.equal(rule.sourceAddressPrefix, "*");
      assert.equal(rule.destinationPortRange, "*");
      if (!mode.publicIpv4) {
        assert.ok(
          !JSON.stringify(template).includes("'network-vm-ip'"),
          "no dangling IPv4 public IP reference",
        );
        assert.ok(!ips.some((item) => item.name === "network-vm-ip"));
      }
    }
  }
});

test("legacy settings default to public IPv4 while IPv6-only settings require IPv6", () => {
  for (const ipv6 of [false, true]) {
    const parsed = vmSettingsSchema.parse({ ...settings, ipv6 });
    assert.equal(parsed.publicIpv4, true);
    assert.equal(parsed.ipv6, ipv6);
  }
  assert.throws(
    () => vmSettingsSchema.parse({ ...settings, publicIpv4: false }),
    /必须启用 IPv6/,
  );
  assert.throws(
    () =>
      vmSettingsSchema.parse({ ...settings, publicIpv4: false, ipv6: false }),
    /必须启用 IPv6/,
  );
  assert.throws(() =>
    vmSettingsSchema.parse({ ...settings, publicIpv4: "false", ipv6: true }),
  );
});

test("IPv6-only mode survives preset save/read/update and reaches the create API unchanged", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true);
  const azure = new Azure(new RequestGate(0));
  const created: ReturnType<typeof createVmSchema.parse>[] = [];
  azure.create = async (_credentials, _account, input) => {
    created.push(input);
  };
  azure.subscriptions = async () => account.subscriptions;
  azure.machines = async () => [];
  const { app, tasks } = await buildApp(config, { store, azure });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: config.adminEmail, password: config.adminPassword },
    });
    const owner = login.json().user.id;
    const headers = {
      cookie: "azpanel_session=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrf,
    };
    store.saveAccount(owner, account, credentials);
    const saved = await app.inject({
      method: "POST",
      url: "/api/presets",
      headers,
      payload: {
        name: "仅公网 IPv6",
        settings: { ...settings, publicIpv4: false, ipv6: true },
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const preset = (
      await app.inject({ url: "/api/presets", headers })
    ).json()[0];
    assert.equal(preset.settings.publicIpv4, false);
    assert.equal(preset.settings.ipv6, true);
    const createUrl = `/api/accounts/${account.id}/machines`;
    const invalid = await app.inject({
      method: "POST",
      url: createUrl,
      headers,
      payload: {
        ...preset.settings,
        ipv6: false,
        name: "no-public-ip",
        confirmation: "no-public-ip",
      },
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal(store.tasks(owner).length, 0);
    const result = await app.inject({
      method: "POST",
      url: createUrl,
      headers,
      payload: {
        ...preset.settings,
        name: "v6-vm",
        confirmation: "v6-vm",
      },
    });
    assert.equal(result.statusCode, 200, result.body);
    await tasks.idle();
    assert.equal(store.task(owner, result.json().taskId)?.status, "succeeded");
    assert.equal(created[0].publicIpv4, false);
    assert.equal(created[0].ipv6, true);
    const updated = await app.inject({
      method: "PUT",
      url: `/api/presets/${preset.id}`,
      headers,
      payload: {
        name: preset.name,
        settings: { ...settings, ipv6: true },
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(
      updated.json().settings.publicIpv4,
      true,
      "old clients keep public IPv4",
    );
  } finally {
    await app.close();
  }
});

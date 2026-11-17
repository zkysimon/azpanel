import { test } from "node:test";
import assert from "node:assert/strict";
import { Azure, RequestGate } from "../server/azure.js";
import { AzureIp } from "../server/azure-ip.js";
import { buildApp } from "../server/app.js";
import { Store } from "../server/store.js";
import type { Json } from "../shared/types.js";
import { account, credentials, machine, testConfig } from "./fixtures.js";

const root = `/subscriptions/${account.subscriptionId}/resourceGroups/${machine.resourceGroup}`;
const nicId = `${root}/providers/Microsoft.Network/networkInterfaces/${machine.name}-nic`;
const oldId = `${root}/providers/Microsoft.Network/publicIPAddresses/${machine.name}-ip`;
const otherId = `${root}/providers/Microsoft.Network/publicIPAddresses/${machine.name}-ip6`;
const configId = `${nicId}/ipConfigurations/ipv4`;
function mock(version = "IPv4") {
  const calls: { method: string; url: URL; body: Json; headers: Headers }[] = [];
  const oldAddress = version === "IPv6" ? "2001:db8::10" : "203.0.113.10";
  const newAddress = version === "IPv6" ? "2001:db8::20" : "203.0.113.20";
  const ip: Json = {
    id: oldId, name: `${machine.name}-ip`, etag: '"ip-old"', location: "eastasia",
    sku: { name: "Standard", tier: "Regional" }, zones: ["1"], tags: { owner: "test" },
    properties: {
      publicIPAddressVersion: version, publicIPAllocationMethod: "Static", idleTimeoutInMinutes: 8,
      provisioningState: "Succeeded", ipAddress: oldAddress, ipConfiguration: { id: configId },
    },
  };
  const nic: Json = {
    id: nicId, name: `${machine.name}-nic`, etag: '"nic-original"', location: "eastasia", tags: { owner: "nic" },
    properties: {
      provisioningState: "Succeeded", virtualMachine: { id: machine.resourceId },
      enableIPForwarding: true, enableAcceleratedNetworking: true,
      networkSecurityGroup: { id: `${root}/providers/Microsoft.Network/networkSecurityGroups/test-nsg`, properties: { readOnly: true } },
      dnsSettings: { dnsServers: ["10.42.0.10"], appliedDnsServers: ["read-only"] },
      ipConfigurations: [
        { name: "ipv4", properties: {
          primary: version === "IPv4", privateIPAddressVersion: version, privateIPAllocationMethod: "Dynamic",
          privateIPAddress: version === "IPv4" ? "10.42.0.4" : "fd00:42::4",
          subnet: { id: `${root}/providers/Microsoft.Network/virtualNetworks/test-vnet/subnets/default`, properties: { readOnly: true } },
          publicIPAddress: { id: oldId, properties: { readOnly: true, deleteOption: "Detach" } },
          applicationSecurityGroups: [{ id: `${root}/providers/Microsoft.Network/applicationSecurityGroups/app`, properties: { readOnly: true } }],
          provisioningState: "Succeeded",
        } },
        { name: "other", properties: {
          primary: version === "IPv6", privateIPAddressVersion: version === "IPv4" ? "IPv6" : "IPv4",
          privateIPAllocationMethod: "Dynamic", publicIPAddress: { id: otherId }, subnet: { id: "same-subnet" },
        } },
      ],
    },
  };
  const state = {
    ip, nic, resources: new Map<string, Json>([[oldId, ip]]),
    quota: false, ambiguousSwitch: false, blockedSwitch: false, oldDeleteFails: false,
    changeDuringCreate: false, unknownNewStatus: false, syncFails: false, targetVisible: true,
    oldReattached: false,
    newId: "", newAddress, oldAddress,
  };
  const azure = new Azure(new RequestGate(0), async (input, options) => {
    const url = new URL(String(input));
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    calls.push({ method, url, body, headers: new Headers(options?.headers) });
    const path = url.pathname;
    if (method === "GET" && path === machine.resourceId)
      return Response.json({ properties: { networkProfile: { networkInterfaces: [{ id: nicId }] } } });
    if (method === "GET" && path === nicId) return Response.json(nic);
    if (method === "GET" && path === "/subscriptions")
      return state.syncFails ? Response.json({ error: { code: "AuthorizationFailed" } }, { status: 403 }) : Response.json({ value: account.subscriptions });
    if (method === "GET" && path.endsWith("/virtualMachines")) return Response.json({ value: [] });
    if (method === "GET" && path === `${root}/resources`)
      return Response.json({ value: [...state.resources.values()].map((ip) => ({ id: ip.id, name: ip.name, type: "Microsoft.Network/publicIPAddresses" })) });
    if (method === "PUT" && path.includes("/publicIPAddresses/")) {
      state.newId = path;
      if (state.quota) return Response.json({ error: { code: "PublicIPCountLimitReached" } }, { status: 409 });
      state.resources.set(path, { ...body, id: path, name: path.split("/").pop(), etag: '"new-ip"',
        properties: { ...body.properties, provisioningState: "Succeeded", ipAddress: newAddress } });
      if (state.changeDuringCreate) nic.etag = '"nic-changed"';
      return Response.json({ properties: { provisioningState: "Succeeded" } });
    }
    if (method === "PUT" && path === nicId) {
      if (state.blockedSwitch) return Response.json({ error: { code: "PreconditionFailed" } }, { status: 412 });
      nic.properties = { ...nic.properties, ...body.properties, provisioningState: "Succeeded" };
      nic.etag = '"nic-updated"';
      delete ip.properties.ipConfiguration;
      if (state.oldReattached) ip.properties.ipConfiguration = { id: `${nicId}-other/ipConfigurations/shared` };
      ip.etag = '"old-detached"';
      const replacement = state.resources.get(state.newId)!;
      replacement.properties.ipConfiguration = { id: configId };
      if (state.unknownNewStatus) delete replacement.properties.ipConfiguration;
      if (state.ambiguousSwitch) throw new TypeError("fetch failed after applying NIC update");
      return Response.json({ properties: { provisioningState: "Succeeded" } });
    }
    if (method === "GET" && state.resources.has(path)) return Response.json(state.resources.get(path));
    if (method === "DELETE" && state.resources.has(path)) {
      if (path === oldId && state.oldDeleteFails) return Response.json({ error: { code: "ScopeLocked" } }, { status: 409 });
      state.resources.delete(path);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 });
  }, async () => "token");
  return { azure, ips: new AzureIp(azure), state, calls };
}

test("IPv4 and IPv6 replacement creates before switching, preserves NIC settings and deletes only detached old IP", async () => {
  for (const version of ["IPv4", "IPv6"]) {
    const { ips, state, calls } = mock(version);
    // This fixture includes another attached IP; supply it so both configurations are inspected.
    state.resources.set(otherId, {
      id: otherId, name: "other-ip", etag: '"other"', location: "eastasia", sku: { name: "Standard" },
      properties: { publicIPAddressVersion: version === "IPv4" ? "IPv6" : "IPv4", publicIPAllocationMethod: "Static", provisioningState: "Succeeded", ipAddress: "other-address", ipConfiguration: { id: `${nicId}/ipConfigurations/other` } },
    });
    const [option] = await ips.options(credentials, account, machine);
    assert.equal(option.version, version);
    assert.equal(option.unavailableReason, undefined);
    const result = await ips.replace(credentials, account, machine, { id: option.id, fingerprint: option.fingerprint, deleteOld: true }, () => {});
    assert.equal(result.newAddress, state.newAddress);
    assert.match(result.message, /旧公网 IP 已删除/);
    const writes = calls.filter((call) => call.method !== "GET");
    assert.deepEqual(writes.map((call) => call.method), ["PUT", "PUT", "DELETE"]);
    assert.equal(writes[0].body.properties.publicIPAddressVersion, version);
    assert.equal(writes[0].headers.get("if-none-match"), "*");
    assert.deepEqual(writes[0].body.zones, ["1"]);
    assert.equal(writes[0].body.tags.azpanelVmId, machine.resourceId);
    assert.equal(writes[1].headers.get("if-match"), '"nic-original"');
    assert.equal(writes[1].body.properties.enableIPForwarding, true);
    assert.equal(writes[1].body.properties.enableAcceleratedNetworking, true);
    assert.deepEqual(writes[1].body.properties.dnsSettings, { dnsServers: ["10.42.0.10"] });
    assert.deepEqual(writes[1].body.properties.networkSecurityGroup, { id: `${root}/providers/Microsoft.Network/networkSecurityGroups/test-nsg` });
    const configs = writes[1].body.properties.ipConfigurations;
    assert.equal(configs.length, 2);
    assert.equal(configs[0].properties.privateIPAddress, version === "IPv4" ? "10.42.0.4" : "fd00:42::4");
    assert.equal(configs[0].properties.publicIPAddress.id, state.newId);
    assert.equal(configs[1].properties.publicIPAddress.id, otherId);
    assert.equal(state.resources.get(otherId)!.properties.ipAddress, "other-address");
    assert.ok(!JSON.stringify(writes[1].body).includes("readOnly"));
    assert.equal(writes[2].url.pathname, oldId);
    assert.equal(writes[2].headers.get("if-match"), '"old-detached"');
    assert.equal(state.resources.has(oldId), false);
    assert.equal(state.resources.has(state.newId), true);
  }
});

test("retaining old IP and failing old cleanup report the new live address without falsely failing the switch", async () => {
  for (const deleteOld of [false, true]) {
    const { ips, state, calls } = mock();
    state.nic.properties.ipConfigurations[1].properties.publicIPAddress = undefined;
    state.oldDeleteFails = true;
    const [option] = await ips.options(credentials, account, machine);
    const result = await ips.replace(credentials, account, machine, { ...option, deleteOld }, () => {});
    assert.equal(result.newAddress, state.newAddress);
    assert.ok(state.resources.has(oldId));
    assert.match(result.message, deleteOld ? /新 IP 已生效.*清理未完成/ : /保留旧公网 IP/);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, deleteOld ? 1 : 0);
  }
});

test("an old IP reattached by another client is never deleted after a successful replacement", async () => {
  const { ips, state, calls } = mock();
  state.nic.properties.ipConfigurations[1].properties.publicIPAddress = undefined;
  const [option] = await ips.options(credentials, account, machine);
  state.oldReattached = true;
  const result = await ips.replace(credentials, account, machine, { ...option, deleteOld: true }, () => {});
  assert.equal(result.newAddress, state.newAddress);
  assert.match(result.message, /旧资源.*清理未完成/);
  assert.ok(state.resources.has(oldId));
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
});

test("stale configuration and unsupported IPs are rejected before writes", async () => {
  const { ips, state, calls } = mock();
  state.nic.properties.ipConfigurations[1].properties.publicIPAddress = undefined;
  const [option] = await ips.options(credentials, account, machine);
  state.nic.etag = '"stale"';
  await assert.rejects(ips.replace(credentials, account, machine, { ...option, deleteOld: true }, () => {}), /配置已变化/);
  state.ip.properties.dnsSettings = { domainNameLabel: "keep-this-name" };
  const [unsupported] = await ips.options(credentials, account, machine);
  assert.match(unsupported.unavailableReason!, /DNS/);
  await assert.rejects(ips.replace(credentials, account, machine, { ...unsupported, deleteOld: true }, () => {}), /DNS/);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
});

test("public IP replacement never invents an absent IPv4 or follows unrelated cross-group attachments", async () => {
  const { ips, state, calls } = mock("IPv6");
  state.nic.properties.ipConfigurations[1].properties.publicIPAddress = undefined;
  const options = await ips.options(credentials, account, machine);
  assert.deepEqual(options.map((option) => option.version), ["IPv6"]);
  state.nic.properties.ipConfigurations[0].properties.publicIPAddress.id = oldId.replace(machine.resourceGroup, "shared-group");
  await assert.rejects(ips.options(credentials, account, machine), /当前资源组/);
  state.nic.properties.ipConfigurations[0].properties.publicIPAddress = undefined;
  assert.deepEqual(await ips.options(credentials, account, machine), []);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
});

test("quota and concurrent change before switch never detach old IP; only proven-unused new IP can be cleaned", async () => {
  for (const failure of ["quota", "changeDuringCreate"] as const) {
    const { ips, state, calls } = mock();
    state.nic.properties.ipConfigurations[1].properties.publicIPAddress = undefined;
    const [option] = await ips.options(credentials, account, machine);
    state[failure] = true;
    await assert.rejects(ips.replace(credentials, account, machine, { ...option, deleteOld: true }, () => {}), /旧 IP 未切换/);
    assert.equal(state.nic.properties.ipConfigurations[0].properties.publicIPAddress.id, oldId);
    assert.ok(state.resources.has(oldId));
    assert.equal(state.resources.has(state.newId), false);
    assert.equal(calls.filter((call) => call.method === "PUT" && call.url.pathname === nicId).length, 0);
  }
});

test("ambiguous/failed/unverified NIC updates never trigger IP deletion or automatic retry", async () => {
  for (const failure of ["ambiguousSwitch", "blockedSwitch", "unknownNewStatus"] as const) {
    const { ips, state, calls } = mock();
    state.nic.properties.ipConfigurations[1].properties.publicIPAddress = undefined;
    const [option] = await ips.options(credentials, account, machine);
    state[failure] = true;
    await assert.rejects(ips.replace(credentials, account, machine, { ...option, deleteOld: true }, () => {}), /未自动删除新旧 IP/);
    assert.ok(state.resources.has(oldId));
    assert.ok(state.resources.has(state.newId));
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
    assert.equal(calls.filter((call) => call.method === "PUT" && call.url.pathname === nicId).length, 1);
  }
});

test("IP replacement API enforces confirmation, isolation, and keeps successful switch separate from sync errors", async () => {
  const config = { ...testConfig, writesEnabled: true };
  const store = new Store(config, true);
  const { azure, state, calls } = mock();
  state.nic.properties.ipConfigurations[1].properties.publicIPAddress = undefined;
  state.syncFails = true;
  const { app, tasks } = await buildApp(config, { store, azure });
  try {
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: config.adminEmail, password: config.adminPassword } });
    const owner = login.json().user.id;
    const headers = { cookie: "azpanel_session=" + login.cookies[0].value, "x-csrf-token": login.json().csrf };
    store.saveAccount(owner, account, credentials);
    store.replaceMachines(account.id, [{ vm: { ...machine, publicIps: [state.oldAddress, "2001:db8::5"] }, raw: {} }]);
    const root = `/api/machines/${machine.id}`;
    const option = (await app.inject({ url: `${root}/ip-options`, headers })).json()[0];
    const payload = { action: "replaceIp", confirmation: machine.name, publicIpId: option.id, fingerprint: option.fingerprint, deleteOldIp: true };
    for (const invalid of [{ ...payload, confirmation: "wrong" }, { ...payload, publicIpId: undefined }, { ...payload, fingerprint: undefined }, { ...payload, force: true }])
      assert.equal((await app.inject({ method: "POST", url: `${root}/action`, headers, payload: invalid })).statusCode, 422);
    const other = store.createUser("ip-other@example.test", "OtherPassword-1234");
    const otherLogin = await app.inject({ method: "POST", url: "/api/login", payload: { email: other.email, password: "OtherPassword-1234" } });
    const otherHeaders = { cookie: "azpanel_session=" + otherLogin.cookies[0].value, "x-csrf-token": otherLogin.json().csrf };
    const before = calls.length;
    assert.equal((await app.inject({ url: `${root}/ip-options`, headers: otherHeaders })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `${root}/action`, headers: otherHeaders, payload })).statusCode, 404);
    assert.equal(calls.length, before);
    const result = await app.inject({ method: "POST", url: `${root}/action`, headers, payload });
    assert.equal(result.statusCode, 200, result.body);
    await tasks.idle();
    const task = store.task(owner, result.json().taskId)!;
    assert.equal(task.status, "succeeded");
    assert.match(task.progress, /203\.0\.113\.20.*同步失败/);
    assert.deepEqual(store.machines(owner)[0].publicIps, ["2001:db8::5", state.newAddress]);
  } finally { await app.close(); }
});

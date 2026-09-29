/** Opt-in live test. Creates one isolated VM; always attempts resource-group cleanup.
 * Secrets are environment-only and the panel database exists only in memory.
 * AZURE_CREDENTIALS_JSON=... npm exec tsx tools/live-lifecycle.ts -- --preflight
 * AZURE_LIVE_CONFIRM=create-manage-delete ... npm exec tsx tools/live-lifecycle.ts
 */
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.js";
import { Azure, RequestGate } from "../server/azure.js";
import { Store } from "../server/store.js";
import type { Config } from "../server/config.js";
import type {
  Account,
  Json,
  MetricPoint,
  Quota,
  Sku,
  Task,
  VirtualMachine,
} from "../shared/types.js";
import { credentialsSchema } from "../shared/validation.js";

const credentials = credentialsSchema.parse(
  JSON.parse(process.env.AZURE_CREDENTIALS_JSON ?? "{}"),
);
delete process.env.AZURE_CREDENTIALS_JSON;
const preflight = process.argv.includes("--preflight");
if (!preflight && process.env.AZURE_LIVE_CONFIRM !== "create-manage-delete")
  throw new Error(
    "Live writes require AZURE_LIVE_CONFIRM=create-manage-delete",
  );
const name = `azptest-${new Date().toISOString().slice(5, 10).replace("-", "")}-${randomBytes(3).toString("hex")}`;
const group = `${name}-azpanel`;
const region = process.env.AZURE_TEST_REGION ?? "eastasia";
const config: Config = {
  encryptionKey: randomBytes(32).toString("hex"),
  dataDir: ":memory:",
  host: "127.0.0.1",
  port: 0,
  adminEmail: "live-test@example.test",
  adminPassword: randomBytes(24).toString("base64url"),
  writesEnabled: !preflight,
  cookieSecure: false,
  azureInterval: 2500,
  avatarSource: "local",
};
let root = "";
let writes = 0,
  reads = 0;
const vmPassword = `Az!${randomBytes(24).toString("base64url")}9`;
const transport: typeof fetch = async (input, options) => {
  const url = new URL(String(input));
  const method = options?.method ?? "GET";
  if (method !== "GET") {
    // Even a bug in the test cannot modify the user's existing resources or provider registration.
    assert.ok(
      !preflight &&
        root &&
        (url.pathname.toLowerCase() === root.toLowerCase() ||
          url.pathname.toLowerCase().startsWith(root.toLowerCase() + "/")),
      `Write outside test group blocked: ${method} ${url.pathname}`,
    );
    writes++;
    console.log(`CLOUD ${method} ${url.pathname}`);
  } else reads++;
  const response = await fetch(input, options);
  if (!response.ok && method !== "GET") {
    const error = await response
      .clone()
      .json()
      .catch(() => ({}));
    // Report codes only: Azure error strings can echo credentials/template parameters.
    const codes = (item: Json): string[] =>
      [item.code, ...(item.details ?? []).flatMap(codes)].filter(Boolean);
    console.log("AZURE_ERROR_CODES", JSON.stringify(codes(error.error ?? {})));
    const details = (item: Json): Json => ({
      code: item.code,
      target: item.target,
      message: String(item.message ?? "")
        .split(credentials.password)
        .join("[redacted]")
        .split(vmPassword)
        .join("[redacted]"),
      details: (item.details ?? []).map(details),
    });
    console.log(
      "AZURE_ERROR_DETAILS",
      JSON.stringify(details(error.error ?? {})),
    );
  }
  return response;
};
const azure = new Azure(new RequestGate(config.azureInterval), transport);
const { app, store, tasks } = await buildApp(config, {
  store: new Store(config, true),
  azure,
});
let headers: Record<string, string> = {};
let account: Account | undefined;
let baselineGroups: string[] = [],
  baselineMachines: Json[] = [];
let attemptedCreate = false,
  cleaned = false,
  failure = false;
const started = Date.now();
const log = (step: string, value: unknown = "") =>
  console.log(
    new Date().toISOString(),
    step,
    typeof value === "string" ? value : JSON.stringify(value),
  );
async function api<T>(
  path: string,
  method = "GET",
  payload?: object,
): Promise<T> {
  const response = await app.inject({
    method: method as "GET",
    url: "/api" + path,
    headers,
    ...(payload ? { payload } : {}),
  });
  const value = response.json();
  if (response.statusCode >= 400)
    throw new Error(`${method} ${path}: ${value.error}`);
  return value as T;
}
async function waitTask(taskId: string): Promise<Task> {
  const deadline = Date.now() + 15 * 60_000;
  let previous = "";
  while (Date.now() < deadline) {
    const task = (await api<Task[]>("/tasks")).find(
      (task) => task.id === taskId,
    );
    assert.ok(task, "Task record missing");
    if (previous !== task.progress) {
      log("TASK", {
        kind: task.kind,
        status: task.status,
        progress: task.progress,
      });
      previous = task.progress;
    }
    if (["succeeded", "failed", "interrupted"].includes(task.status)) {
      if (task.status !== "succeeded")
        throw new Error(`${task.kind}: ${task.error ?? task.progress}`);
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    "Task timeout; cleanup will wait for the in-flight task before deleting its group",
  );
}
async function task(path: string, payload?: object, method = "POST") {
  const result = await api<{ taskId: string }>(path, method, payload);
  return waitTask(result.taskId);
}
async function testVm() {
  const inventory = await api<VirtualMachine[]>("/machines");
  const vm = inventory.find(
    (vm) =>
      vm.name.toLowerCase() === name.toLowerCase() &&
      vm.resourceGroup.toLowerCase() === group.toLowerCase(),
  );
  if (!vm)
    log(
      "INVENTORY_MISMATCH",
      inventory.map((vm) => ({
        name: vm.name,
        group: vm.resourceGroup,
        state: vm.powerState,
      })),
    );
  assert.ok(vm, "Created VM missing from synchronized panel inventory");
  assert.equal(vm.accountId, account!.id);
  assert.equal(
    vm.resourceId.toLowerCase().startsWith(root.toLowerCase() + "/"),
    true,
  );
  return vm;
}
async function manage(action: string, expected: string) {
  const vm = await testVm();
  await task(`/machines/${vm.id}/action`, { action, confirmation: name });
  const current = await testVm();
  assert.equal(
    current.powerState,
    expected,
    `${action} returned unexpected power state`,
  );
  log("MANAGEMENT_PASS", { action, state: current.powerState });
}

try {
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { email: config.adminEmail, password: config.adminPassword },
  });
  assert.equal(login.statusCode, 200);
  headers = {
    cookie: "azpanel_session=" + login.cookies[0].value,
    "x-csrf-token": login.json().csrf,
  };
  account = await api<Account>("/accounts", "POST", {
    label: `临时实测 ${name}`,
    credentials,
  });
  assert.equal(account.state, "Enabled");
  root = `/subscriptions/${account.subscriptionId}/resourceGroups/${group}`;
  baselineGroups = (await api<Json[]>(`/accounts/${account.id}/groups`))
    .map((group) => group.name)
    .sort();
  assert.ok(
    !baselineGroups.some(
      (value) => value.toLowerCase() === group.toLowerCase(),
    ),
  );
  baselineMachines = await azure.list(
    credentials,
    `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2024-11-01`,
  );
  log("BASELINE", {
    subscription: account.subscriptionName,
    state: account.state,
    groups: baselineGroups,
    machines: baselineMachines.map((vm) => ({
      name: vm.name,
      size: vm.properties.hardwareProfile.vmSize,
    })),
  });
  const quotas = await api<Quota[]>(
    `/accounts/${account.id}/quotas?region=${region}`,
  );
  log(
    "QUOTAS",
    quotas.filter((quota) =>
      [
        "cores",
        "virtualMachines",
        "standardBSFamily",
        "standardBasv2Family",
      ].some((name) => name.toLowerCase() === quota.name.toLowerCase()),
    ),
  );
  const skus = await api<Sku[]>(
    `/accounts/${account.id}/skus?region=${region}`,
  );
  const candidates = [
    "Standard_B1s",
    "Standard_B1ms",
    "Standard_B2ats_v2",
    "Standard_B2s",
  ];
  log(
    "SKUS",
    skus.filter((sku) => candidates.includes(sku.name)),
  );
  const chosen = candidates
    .map((name) =>
      skus.find(
        (sku) =>
          sku.name === name &&
          !sku.restricted &&
          sku.generations.includes("V2") &&
          sku.architecture.toLowerCase() !== "arm64",
      ),
    )
    .find(Boolean);
  if (!chosen)
    throw new Error(
      `No supported low-cost SKU available in ${region}; no VM was created`,
    );
  const cores = quotas.find((quota) => quota.name.toLowerCase() === "cores");
  const family = quotas.find(
    (quota) =>
      quota.name.toLowerCase() ===
      (chosen.name.includes("ats_v2")
        ? "standardbasv2family"
        : "standardbsfamily"),
  );
  if (cores && cores.limit - cores.current < chosen.cpus)
    throw new Error("Insufficient regional vCPU quota");
  if (family && family.limit - family.current < chosen.cpus)
    throw new Error("Insufficient VM family quota");
  log("SELECTED", { name, group, region, size: chosen.name, diskGiB: 30 });
  if (!preflight) {
    attemptedCreate = true;
    await task(`/accounts/${account.id}/machines`, {
      name,
      confirmation: name,
      location: region,
      size: chosen.name,
      image: "ubuntu-24",
      diskSize: 30,
      username: "azuretest",
      authentication: "password",
      password: vmPassword,
      // Documentation-only source address prevents Internet login attempts during the short management test.
      allowedSource: "192.0.2.1/32",
      ipv6: false,
      customData: "",
    });
    const vm = await testVm();
    log("SYNCHRONIZED_ID", { name: vm.name, group: vm.resourceGroup });
    assert.equal(vm.powerState, "running");
    log("CREATE_PASS", {
      name: vm.name,
      size: vm.size,
      state: vm.powerState,
      publicIps: vm.publicIps.length,
      diskGiB: vm.diskSize,
    });
    const metrics = await api<MetricPoint[]>(`/machines/${vm.id}/metrics`);
    log("METRICS_PASS", {
      points: metrics.length,
      sampledCpu: metrics.filter((point) => point.cpu !== null).length,
    });
    const resources = await api<Json[]>(
      `/accounts/${account.id}/resources?group=${group}`,
    );
    log(
      "RESOURCE_QUERY_PASS",
      resources.map((resource) => ({
        name: resource.name,
        type: resource.type,
      })),
    );
    await manage("restart", "running");
    await manage("deallocate", "deallocated");
    await manage("start", "running");
    log("LIFECYCLE_PASS");
  }
} catch (error) {
  failure = true;
  log("TEST_FAILURE", error instanceof Error ? error.message : "unknown error");
} finally {
  try {
    await tasks.idle();
    if (attemptedCreate && account) {
      const groups = await api<Json[]>(`/accounts/${account.id}/groups`);
      if (
        groups.some((item) => item.name.toLowerCase() === group.toLowerCase())
      ) {
        log("CLEANUP_START", group);
        try {
          await task(
            `/accounts/${account.id}/groups`,
            { group, confirmation: group },
            "DELETE",
          );
        } catch (error) {
          log("CLEANUP_API_ERROR", (error as Error).message);
          await tasks.idle();
          // Read before fallback to avoid resubmitting an already-completed delete.
          const remaining = await azure.groups(credentials, account);
          if (
            remaining.some(
              (item) => item.name.toLowerCase() === group.toLowerCase(),
            )
          ) {
            await azure.operation(
              credentials,
              "DELETE",
              `${root}?api-version=2021-04-01`,
              undefined,
              (message) => log("CLEANUP", message),
            );
          }
        }
      }
      const groupsAfter = (await azure.groups(credentials, account))
        .map((group) => group.name)
        .sort();
      const machinesAfter = await azure.list(
        credentials,
        `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2024-11-01`,
      );
      const resourcesAfter = await azure.list(
        credentials,
        `/subscriptions/${account.subscriptionId}/resources?api-version=2021-04-01`,
      );
      assert.ok(!groupsAfter.includes(group), "Temporary group still exists");
      assert.equal(
        resourcesAfter.filter((resource) =>
          resource.id.toLowerCase().startsWith(root.toLowerCase() + "/"),
        ).length,
        0,
        "Orphaned test resource remains",
      );
      assert.deepEqual(
        groupsAfter,
        baselineGroups,
        "Resource group inventory differs from baseline",
      );
      assert.deepEqual(
        machinesAfter.map((vm) => vm.id.toLowerCase()).sort(),
        baselineMachines.map((vm) => vm.id.toLowerCase()).sort(),
        "VM inventory differs from baseline",
      );
      for (const original of baselineMachines) {
        const current = machinesAfter.find((vm) => vm.id === original.id)!;
        assert.deepEqual(
          current.properties.hardwareProfile,
          original.properties.hardwareProfile,
        );
        const { data: view } = await azure.request(
          credentials,
          "GET",
          `${original.id}/instanceView?api-version=2024-11-01`,
        );
        log("EXISTING_VM_AFTER", {
          name: original.name,
          state: view.statuses?.find((status: Json) =>
            status.code.startsWith("PowerState/"),
          )?.code,
        });
      }
      cleaned = true;
      log("CLEANUP_VERIFIED", {
        remainingTestResources: 0,
        groups: groupsAfter.length,
        originalMachines: machinesAfter.length,
      });
    }
  } catch (error) {
    failure = true;
    log("CLEANUP_FAILURE", { group, message: (error as Error).message });
  }
  log("SUMMARY", {
    name,
    group,
    preflight,
    attemptedCreate,
    cleaned,
    failure,
    reads,
    writes,
    durationSeconds: Math.round((Date.now() - started) / 1000),
  });
  await app.close();
}
if (failure) process.exitCode = 1;

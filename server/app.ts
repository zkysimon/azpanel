import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Account,
  Credentials,
  Invite,
  User,
  VmPreset,
  TaskItemResult,
} from "../shared/types.js";
import {
  accountSchema,
  createVmSchema,
  inviteSchema,
  presetSchema,
  registerSchema,
  regionSchema,
  sizeSchema,
} from "../shared/validation.js";
import { AppError, Store } from "./store.js";
import { avatarUrl } from "./avatar.js";
import { hashPassword, hashToken, verifyPassword } from "./security.js";
import type { Config } from "./config.js";
import { Azure, RequestGate, selectSubscription } from "./azure.js";
import { Tasks } from "./tasks.js";
import { AzureAi } from "./azure-ai.js";
import { AzureBilling } from "./azure-billing.js";
import type { BillingSummary } from "../shared/billing.js";
import {
  aiServiceSchema,
  aiCreateServiceSchema,
  aiDeploySchema,
  aiDeleteSchema,
} from "../shared/ai.js";

declare module "fastify" {
  interface FastifyRequest {
    currentUser: User | null;
    csrf: string;
  }
}
const idParams = z.object({ id: z.string().min(1).max(128) });
const confirmationSchema = z.object({ confirmation: z.string() });
export async function buildApp(
  config: Config,
  supplied?: { store?: Store; azure?: Azure },
) {
  const store = supplied?.store ?? new Store(config);
  const azure =
    supplied?.azure ?? new Azure(new RequestGate(config.azureInterval));
  const tasks = new Tasks(store);
  const ai = new AzureAi(azure);
  const billing = new AzureBilling(azure);
  const billingLoads = new Map<string, Promise<BillingSummary>>();
  const app = Fastify({ logger: false, bodyLimit: 100_000, trustProxy: false });
  app.decorateRequest("currentUser", null);
  app.decorateRequest("csrf", "");
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.status(422).send({
        error: error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("；"),
      });
    if (error instanceof AppError)
      return reply.status(error.status).send({ error: error.message });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429)
      return reply.status(429).send({ error: "请求过于频繁，请稍后再试" });
    if (statusCode && statusCode < 500)
      return reply.status(statusCode).send({ error: "请求格式无效" });
    return reply
      .status(500)
      .send({ error: "服务内部错误，请检查配置或稍后重试" });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "same-origin");
    if (/^\/api(?:%2f|%5c)/i.test(request.url))
      throw new AppError(400, "无效的 API 路径");
    const route = request.routeOptions.url ?? request.url.split("?")[0];
    if (!route.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const token = request.cookies.azpanel_session;
    if (token) {
      const row = store.db
        .prepare(
          "SELECT u.id,u.email,u.role,u.disabled,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?",
        )
        .get(hashToken(token), Date.now()) as unknown as
        (User & { csrf: string; disabled: number }) | undefined;
      if (row && row.disabled !== 1) {
        request.currentUser = { id: row.id, email: row.email, role: row.role };
        request.csrf = row.csrf;
      }
    }
    const publicPath = [
      "/api/session",
      "/api/login",
      "/api/register",
      "/api/health",
    ].includes(route);
    if (!publicPath && !request.currentUser)
      throw new AppError(401, "请先登录");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).host !== request.headers.host) throw new Error();
        } catch {
          throw new AppError(403, "请求来源不匹配");
        }
      }
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw new AppError(403, "拒绝跨站请求");
      if (
        !["/api/login", "/api/register"].includes(route) &&
        (!request.csrf || request.headers["x-csrf-token"] !== request.csrf)
      )
        throw new AppError(403, "安全令牌已过期，请刷新页面");
    }
  });
  const user = (request: FastifyRequest) => request.currentUser!;
  function accountContext(request: FastifyRequest) {
    const { id } = idParams.parse(request.params);
    return {
      account: store.account(user(request).id, id),
      credentials: store.credentials(user(request).id, id),
    };
  }
  function checkWrites() {
    if (!config.writesEnabled)
      throw new AppError(
        403,
        "云端写操作已关闭。启用 AZURE_ALLOW_WRITES 后重启服务才可执行。",
      );
  }
  function confirm(value: string, target: string) {
    if (value !== target) throw new AppError(422, "确认名称不匹配");
  }
  async function sync(
    userId: string,
    account: Account,
    credentials: Credentials,
    progress: (message: string) => void,
  ) {
    try {
      progress("读取订阅状态");
      account.subscriptions = await azure.subscriptions(credentials);
      const subscription = selectSubscription(
        account.subscriptions,
        account.subscriptionId,
      );
      account.state = subscription.state;
      account.subscriptionName = subscription.displayName;
      progress("同步虚拟机及网络信息（限速执行）");
      const machines = await azure.machines(credentials, account);
      store.replaceMachines(account.id, machines);
      account.lastSync = Date.now();
      account.error = null;
      store.saveAccount(userId, account);
    } catch (error) {
      account.error = error instanceof AppError ? error.message : "同步失败";
      store.saveAccount(userId, account);
      throw error;
    }
  }
  app.get("/api/health", async () => ({ status: "ok", version: "2.0.0" }));
  app.get("/api/session", async (request) => ({
    user: request.currentUser
      ? {
          ...request.currentUser,
          avatarUrl: avatarUrl(request.currentUser.email, config.avatarSource),
        }
      : null,
    csrf: request.csrf,
    writesEnabled: config.writesEnabled,
    registrationOpen: store.setting("registration_open") === "1",
  }));
  app.post(
    "/api/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      if (store.setting("registration_open") !== "1")
        throw new AppError(403, "当前未开放注册");
      const input = registerSchema.parse(request.body);
      const created = store.redeemInvite(
        input.inviteCode,
        input.email,
        input.password,
      );
      store.audit(created.id, "注册", created.email);
      return { user: created };
    },
  );
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = z
        .object({
          email: z.string().email().toLowerCase(),
          password: z.string().min(1).max(256),
        })
        .parse(request.body);
      const row = store.db
        .prepare("SELECT * FROM users WHERE email=?")
        .get(input.email) as unknown as
        (User & { password: string; disabled: number }) | undefined;
      if (!row || !verifyPassword(input.password, row.password))
        throw new AppError(401, "邮箱或密码不正确");
      if (row.disabled === 1)
        throw new AppError(403, "账户已被停用，请联系管理员");
      const token = randomBytes(32).toString("hex"),
        csrf = randomBytes(24).toString("hex");
      store.db
        .prepare("DELETE FROM sessions WHERE expires_at < ?")
        .run(Date.now());
      store.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
        .run(hashToken(token), row.id, csrf, Date.now() + 12 * 3600000);
      reply.setCookie("azpanel_session", token, {
        path: "/",
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: "strict",
        maxAge: 43200,
      });
      store.audit(row.id, "登录", "控制台");
      return {
        user: {
          id: row.id,
          email: row.email,
          role: row.role,
          avatarUrl: avatarUrl(row.email, config.avatarSource),
        },
        csrf,
        writesEnabled: config.writesEnabled,
        registrationOpen: store.setting("registration_open") === "1",
      };
    },
  );
  app.post("/api/logout", async (request, reply) => {
    store.db
      .prepare("DELETE FROM sessions WHERE token=?")
      .run(hashToken(request.cookies.azpanel_session ?? ""));
    reply.clearCookie("azpanel_session", { path: "/" });
    return { ok: true };
  });
  app.put("/api/password", async (request, reply) => {
    const input = z
      .object({
        current: z.string().max(256),
        password: z.string().min(12).max(256),
      })
      .parse(request.body);
    const row = store.db
      .prepare("SELECT password FROM users WHERE id=?")
      .get(user(request).id) as { password: string };
    if (!verifyPassword(input.current, row.password))
      throw new AppError(422, "当前密码不正确");
    store.db
      .prepare("UPDATE users SET password=? WHERE id=?")
      .run(hashPassword(input.password), user(request).id);
    store.db
      .prepare("DELETE FROM sessions WHERE user_id=?")
      .run(user(request).id);
    reply.clearCookie("azpanel_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/overview", async (request) => {
    const accounts = store.accounts(user(request).id),
      machines = store.machines(user(request).id);
    return {
      accounts: accounts.length,
      enabled: accounts.filter((account) => account.state === "Enabled").length,
      machines: machines.length,
      running: machines.filter((vm) => vm.powerState === "running").length,
      regions: new Set(machines.map((vm) => vm.location)).size,
      tasks: store.tasks(user(request).id).slice(0, 5),
      recentMachines: machines.slice(0, 5),
    };
  });
  app.get("/api/accounts", async (request) => store.accounts(user(request).id));
  app.post(
    "/api/accounts",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request) => {
      const input = accountSchema.parse(request.body);
      const subscriptions = await azure.subscriptions(input.credentials);
      const selected = selectSubscription(subscriptions, input.subscriptionId);
      if (
        store
          .accounts(user(request).id)
          .some(
            (account) =>
              account.appId === input.credentials.appId &&
              account.subscriptionId === selected.subscriptionId,
          )
      )
        throw new AppError(409, "该应用和订阅已经接入");
      const account: Account = {
        id: randomUUID(),
        label: input.label,
        appId: input.credentials.appId,
        tenant: input.credentials.tenant,
        subscriptionId: selected.subscriptionId,
        subscriptionName: selected.displayName,
        state: selected.state,
        subscriptions,
        createdAt: Date.now(),
        lastSync: null,
        error: null,
      };
      store.saveAccount(user(request).id, account, input.credentials);
      store.audit(user(request).id, "接入账户", account.label);
      return account;
    },
  );
  app.put("/api/accounts/:id", async (request) => {
    const { account } = accountContext(request);
    const input = z
      .object({
        label: z.string().trim().min(1).max(100),
        password: z.string().max(512).optional(),
      })
      .parse(request.body);
    const credentials = store.credentials(user(request).id, account.id);
    if (input.password) {
      credentials.password = input.password;
      const subscriptions = await azure.subscriptions(credentials);
      const subscription = selectSubscription(
        subscriptions,
        account.subscriptionId,
      );
      account.state = subscription.state;
      account.subscriptions = subscriptions;
      account.error = null;
      store.db
        .prepare("DELETE FROM billing_cache WHERE account_id=?")
        .run(account.id);
    }
    account.label = input.label;
    store.saveAccount(user(request).id, account, credentials);
    store.audit(user(request).id, "更新账户", account.label);
    return account;
  });
  app.delete("/api/accounts/:id", async (request) => {
    const { account } = accountContext(request);
    confirm(confirmationSchema.parse(request.body).confirmation, account.label);
    if (
      store.db
        .prepare(
          "SELECT id FROM tasks WHERE account_id=? AND status IN ('queued','running')",
        )
        .get(account.id)
    )
      throw new AppError(409, "账户有未完成任务");
    store.db
      .prepare("DELETE FROM accounts WHERE id=? AND user_id=?")
      .run(account.id, user(request).id);
    store.audit(user(request).id, "移除本地账户", account.label);
    return { ok: true };
  });
  app.post("/api/accounts/:id/sync", async (request) => {
    const { account, credentials } = accountContext(request);
    if (account.lastSync && Date.now() - account.lastSync < 60000)
      throw new AppError(429, "已在一分钟内同步过，请稍后再试");
    return {
      taskId: tasks.enqueue(
        user(request).id,
        account.id,
        "同步资源",
        account.label,
        (progress) => sync(user(request).id, account, credentials, progress),
      ),
    };
  });
  app.get("/api/accounts/:id/locations", async (request) => {
    const { account, credentials } = accountContext(request);
    return azure.locations(credentials, account);
  });
  app.get("/api/accounts/:id/billing", async (request) => {
    const { account, credentials } = accountContext(request);
    const cached = store.db
      .prepare("SELECT data,expires_at FROM billing_cache WHERE account_id=?")
      .get(account.id) as { data: string; expires_at: number } | undefined;
    if (cached && cached.expires_at > Date.now())
      return JSON.parse(cached.data) as BillingSummary;
    const pending = billingLoads.get(account.id);
    if (pending) return pending;
    const load = billing
      .summary(credentials, account)
      .then((summary) => {
        if (
          store.db
            .prepare("SELECT id FROM accounts WHERE id=? AND user_id=?")
            .get(account.id, user(request).id)
        ) {
          const ttl =
            summary.credit.status === "error" ||
            summary.spending.status === "error"
              ? 60000
              : 900000;
          store.db
            .prepare("INSERT OR REPLACE INTO billing_cache VALUES(?,?,?)")
            .run(account.id, JSON.stringify(summary), Date.now() + ttl);
        }
        return summary;
      })
      .finally(() => billingLoads.delete(account.id));
    billingLoads.set(account.id, load);
    return load;
  });
  app.get("/api/accounts/:id/images", async (request) => {
    const { account, credentials } = accountContext(request);
    const { region } = z.object({ region: regionSchema }).parse(request.query);
    return azure.imageOptions(credentials, account, region);
  });
  app.get("/api/accounts/:id/skus", async (request) => {
    const { account, credentials } = accountContext(request);
    const { region } = z.object({ region: regionSchema }).parse(request.query);
    return azure.skus(credentials, account, region);
  });
  app.get("/api/accounts/:id/quotas", async (request) => {
    const { account, credentials } = accountContext(request);
    const { region } = z.object({ region: regionSchema }).parse(request.query);
    return azure.quotas(credentials, account, region);
  });
  app.get("/api/accounts/:id/ai/services", async (request) => {
    const { account, credentials } = accountContext(request);
    const { refresh } = z
      .object({ refresh: z.enum(["true", "false"]).optional() })
      .parse(request.query);
    return ai.services(credentials, account, refresh === "true");
  });
  app.post("/api/accounts/:id/ai/services", async (request) => {
    checkWrites();
    const { account, credentials } = accountContext(request);
    const input = aiCreateServiceSchema.parse(request.body);
    if (account.state !== "Enabled") throw new AppError(422, "当前订阅不可用");
    return {
      taskId: tasks.enqueue(
        user(request).id,
        account.id,
        "创建 AI 服务",
        input.name,
        (progress) => ai.createService(credentials, account, input, progress),
      ),
    };
  });
  app.get("/api/accounts/:id/ai/models", async (request) => {
    const { account, credentials } = accountContext(request);
    return ai.models(
      credentials,
      account,
      aiServiceSchema.parse(request.query),
    );
  });
  app.get("/api/accounts/:id/ai/deployments", async (request) => {
    const { account, credentials } = accountContext(request);
    return ai.deployments(
      credentials,
      account,
      aiServiceSchema.parse(request.query),
      z
        .object({ refresh: z.enum(["true", "false"]).optional() })
        .parse(request.query).refresh === "true",
    );
  });
  app.get("/api/accounts/:id/ai/usages", async (request) => {
    const { account, credentials } = accountContext(request);
    return ai.usages(
      credentials,
      account,
      aiServiceSchema.parse(request.query),
    );
  });
  app.post("/api/accounts/:id/ai/deployments", async (request) => {
    checkWrites();
    const { account, credentials } = accountContext(request);
    const input = aiDeploySchema.parse(request.body);
    if (account.state !== "Enabled") throw new AppError(422, "当前订阅不可用");
    return {
      taskId: tasks.enqueue(
        user(request).id,
        account.id,
        "部署 AI 模型",
        input.deployment,
        (progress) => ai.deploy(credentials, account, input, progress),
      ),
    };
  });
  app.delete("/api/accounts/:id/ai/deployments", async (request) => {
    checkWrites();
    const { account, credentials } = accountContext(request);
    const input = aiDeleteSchema.parse(request.body);
    return {
      taskId: tasks.enqueue(
        user(request).id,
        account.id,
        "删除 AI 部署",
        input.deployment,
        (progress) =>
          ai.deleteDeployment(
            credentials,
            account,
            input,
            input.deployment,
            progress,
          ),
      ),
    };
  });
  app.get("/api/accounts/:id/groups", async (request) => {
    const { account, credentials } = accountContext(request);
    return azure.groups(credentials, account);
  });
  app.get("/api/accounts/:id/resources", async (request) => {
    const { account, credentials } = accountContext(request);
    const { group } = z
      .object({ group: z.string().regex(/^[\w.()-]{1,90}$/) })
      .parse(request.query);
    return azure.groupResources(credentials, account, group);
  });
  app.delete("/api/accounts/:id/groups", async (request) => {
    checkWrites();
    const { account, credentials } = accountContext(request);
    const input = z
      .object({
        group: z.string().regex(/^[\w.()-]{1,90}$/),
        confirmation: z.string(),
      })
      .parse(request.body);
    confirm(input.confirmation, input.group);
    await azure.assertGroupEmpty(credentials, account, input.group);
    return {
      taskId: tasks.enqueue(
        user(request).id,
        account.id,
        "删除资源组",
        input.group,
        async (progress) => {
          await azure.deleteEmptyGroup(
            credentials,
            account,
            input.group,
            progress,
          );
        },
      ),
    };
  });
  app.post("/api/accounts/:id/groups/delete-batch", async (request) => {
    checkWrites();
    const { account, credentials } = accountContext(request);
    const { groups, confirmation } = z
      .object({
        groups: z
          .array(z.string().regex(/^[\w.()-]{1,90}$/))
          .min(1)
          .max(50)
          .refine(
            (items) =>
              new Set(items.map((item) => item.toLowerCase())).size ===
              items.length,
            "资源组不能重复",
          ),
        confirmation: z.literal("DELETE"),
      })
      .parse(request.body);
    confirm(confirmation, "DELETE");
    if (
      store
        .tasks(user(request).id)
        .some(
          (task) =>
            task.accountId === account.id &&
            ["queued", "running"].includes(task.status),
        )
    ) {
      throw new AppError(409, "该账户已有任务正在执行，请等待完成");
    }
    const results: TaskItemResult[] = [];
    for (const group of groups) {
      try {
        await azure.assertGroupEmpty(credentials, account, group);
        results.push({ name: group, status: "queued" });
      } catch (error) {
        results.push({
          name: group,
          status: "failed",
          message:
            error instanceof AppError
              ? error.message
              : "检查资源组失败，已跳过删除",
        });
      }
    }
    const eligible = results.filter((result) => result.status === "queued");
    if (!eligible.length) return { taskId: null, results };
    const taskId = tasks.enqueue(
      user(request).id,
      account.id,
      "批量删除空资源组",
      `${eligible.length} 个资源组`,
      async (progress) => {
        const completed: TaskItemResult[] = results.filter(
          (result) => result.status === "failed",
        );
        for (const item of eligible) {
          progress(`正在删除 ${item.name}`);
          try {
            await azure.deleteEmptyGroup(
              credentials,
              account,
              item.name,
              progress,
            );
            completed.push({ name: item.name, status: "succeeded" });
          } catch (error) {
            completed.push({
              name: item.name,
              status: "failed",
              message:
                error instanceof AppError
                  ? error.message
                  : "删除失败，请刷新 Azure 资源状态",
            });
          }
        }
        return completed;
      },
    );
    return { taskId, results };
  });
  app.get("/api/machines", async (request) => store.machines(user(request).id));
  app.get("/api/machines/:id", async (request) =>
    store.machine(user(request).id, idParams.parse(request.params).id),
  );
  app.get("/api/machines/:id/metrics", async (request) => {
    const { vm } = store.machine(
      user(request).id,
      idParams.parse(request.params).id,
    );
    return azure.metrics(store.credentials(user(request).id, vm.accountId), vm);
  });
  app.post("/api/accounts/:id/machines", async (request) => {
    checkWrites();
    const { account, credentials } = accountContext(request);
    const input = createVmSchema.parse(request.body);
    if (account.state !== "Enabled") throw new AppError(422, "当前订阅不可用");
    return {
      taskId: tasks.enqueue(
        user(request).id,
        account.id,
        "创建虚拟机",
        input.name,
        async (progress) => {
          await azure.create(credentials, account, input, progress);
          await sync(user(request).id, account, credentials, progress);
        },
      ),
    };
  });
  app.post("/api/machines/:id/action", async (request) => {
    checkWrites();
    const { vm } = store.machine(
      user(request).id,
      idParams.parse(request.params).id,
    );
    const input = z
      .object({
        action: z.enum([
          "start",
          "powerOff",
          "deallocate",
          "restart",
          "delete",
          "resize",
          "disk",
        ]),
        confirmation: z.string(),
        size: sizeSchema.optional(),
        diskSize: z.number().int().min(30).max(4095).optional(),
      })
      .parse(request.body);
    confirm(input.confirmation, vm.name);
    if (input.action === "resize" && !input.size)
      throw new AppError(422, "请选择新规格");
    if (input.action === "disk" && !input.diskSize)
      throw new AppError(422, "请选择新系统盘容量");
    const account = store.account(user(request).id, vm.accountId),
      credentials = store.credentials(user(request).id, vm.accountId);
    return {
      taskId: tasks.enqueue(
        user(request).id,
        account.id,
        input.action,
        vm.name,
        async (progress) => {
          if (input.action === "delete")
            await azure.deleteVm(credentials, vm, progress);
          else if (input.action === "resize")
            await azure.resize(credentials, vm, input.size!, progress);
          else if (input.action === "disk")
            await azure.resizeDisk(credentials, vm, input.diskSize!, progress);
          else await azure.vmAction(credentials, vm, input.action, progress);
          await sync(user(request).id, account, credentials, progress);
        },
      ),
    };
  });
  app.get("/api/tasks", async (request) => store.tasks(user(request).id));
  app.get("/api/tasks/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const task = store.task(user(request).id, id);
    if (!task) throw new AppError(404, "任务不存在");
    return task;
  });
  app.get("/api/presets", async (request) => store.presets(user(request).id));
  app.post("/api/presets", async (request) => {
    const input = presetSchema.parse(request.body);
    const now = Date.now();
    const preset: VmPreset = {
      id: randomUUID(),
      name: input.name,
      isDefault: input.isDefault,
      settings: input.settings,
      updatedAt: now,
    };
    store.savePreset(user(request).id, preset);
    store.audit(user(request).id, "保存虚拟机预设", preset.name);
    return preset;
  });
  app.put("/api/presets/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const existing = store.preset(user(request).id, id);
    const input = presetSchema.parse(request.body);
    const preset: VmPreset = {
      ...existing,
      name: input.name,
      isDefault: input.isDefault,
      settings: input.settings,
      updatedAt: Date.now(),
    };
    store.savePreset(user(request).id, preset);
    store.audit(user(request).id, "更新虚拟机预设", preset.name);
    return preset;
  });
  app.delete("/api/presets/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    store.preset(user(request).id, id);
    store.deletePreset(user(request).id, id);
    store.audit(user(request).id, "删除虚拟机预设", id);
    return { ok: true };
  });
  const requireAdmin = (request: FastifyRequest) => {
    if (user(request).role !== "admin")
      throw new AppError(403, "需要管理员权限");
  };
  app.get("/api/invites", async (request) => {
    requireAdmin(request);
    return {
      registrationOpen: store.setting("registration_open") === "1",
      invites: store.invites(),
    };
  });
  app.post("/api/invites", async (request) => {
    requireAdmin(request);
    const input = inviteSchema.parse(request.body);
    const now = Date.now();
    // 10 readable groups from an unambiguous alphabet (no O/0/I/1 confusables).
    const code = Array.from({ length: 4 }, () =>
      Array.from(
        { length: 4 },
        () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[randomBytes(1)[0] % 32],
      ).join(""),
    ).join("-");
    const invite: Invite = {
      id: randomUUID(),
      code,
      note: input.note,
      maxUses: input.maxUses,
      uses: 0,
      expiresAt:
        input.expiresInDays === null
          ? null
          : now + input.expiresInDays * 86400000,
      createdAt: now,
      createdBy: user(request).email,
      lastUsedAt: null,
    };
    store.createInvite(invite);
    store.audit(user(request).id, "生成邀请码", invite.code);
    return invite;
  });
  app.delete("/api/invites/:id", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    store.deleteInvite(id);
    store.audit(user(request).id, "删除邀请码", id);
    return { ok: true };
  });
  app.put("/api/invites/registration", async (request) => {
    requireAdmin(request);
    const { open } = z.object({ open: z.boolean() }).parse(request.body);
    store.setSetting("registration_open", open ? "1" : "0");
    store.audit(user(request).id, open ? "开放注册" : "关闭注册", "设置");
    return { registrationOpen: open };
  });
  app.get("/api/audit", async (request) =>
    store.db
      .prepare(
        "SELECT id,action,target,created_at AS createdAt FROM audit WHERE user_id=? ORDER BY id DESC LIMIT 100",
      )
      .all(user(request).id),
  );
  app.get("/api/users", async (request) => {
    requireAdmin(request);
    return store.managedUsers().map((member) => ({
      ...member,
      avatarUrl: avatarUrl(member.email, config.avatarSource),
    }));
  });
  app.post("/api/users", async (request) => {
    requireAdmin(request);
    const input = z
      .object({
        email: z.string().email(),
        password: z.string().min(12).max(256),
        role: z.enum(["admin", "user"]),
      })
      .parse(request.body);
    if (
      store.db
        .prepare("SELECT id FROM users WHERE email=?")
        .get(input.email.toLowerCase())
    )
      throw new AppError(409, "邮箱已存在");
    const created = store.createUser(input.email, input.password, input.role);
    store.audit(user(request).id, "创建用户", input.email);
    return created;
  });
  app.patch("/api/users/:id", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const input = z
      .object({
        email: z.string().email().optional(),
        role: z.enum(["admin", "user"]).optional(),
        disabled: z.boolean().optional(),
      })
      .parse(request.body);
    if (input.email || input.role)
      store.updateUser(user(request).id, id, {
        email: input.email,
        role: input.role,
      });
    if (input.disabled !== undefined)
      store.setDisabled(user(request).id, id, input.disabled);
    store.audit(
      user(request).id,
      "更新用户",
      [
        input.email,
        input.role,
        input.disabled === undefined ? null : `disabled=${input.disabled}`,
      ]
        .filter(Boolean)
        .join(" ") || id,
    );
    return store.managedUsers().find((member) => member.id === id);
  });
  app.put("/api/users/:id/password", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const { password } = z
      .object({ password: z.string().min(12).max(256) })
      .parse(request.body);
    store.resetPassword(id, password);
    store.audit(user(request).id, "重置用户密码", id);
    return { ok: true };
  });
  app.delete("/api/users/:id", async (request) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const target = store.managedUsers().find((member) => member.id === id);
    store.deleteUser(user(request).id, id);
    store.audit(user(request).id, "删除用户", target?.email ?? id);
    return { ok: true };
  });
  const staticRoot = resolve("dist/client");
  if (existsSync(staticRoot)) {
    await app.register(staticFiles, { root: staticRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.status(404).send({ error: "接口不存在" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    await tasks.idle();
    await Promise.allSettled(billingLoads.values());
    store.close();
  });
  return { app, store, azure, tasks };
}

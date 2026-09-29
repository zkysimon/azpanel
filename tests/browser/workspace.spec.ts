import { test, expect } from "@playwright/test";
import { testConfig } from "../fixtures.js";

test("login, navigation, MD3 theme, resource details, quota and mobile layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
      console.error("Console:", message.text());
    }
  });
  page.on("requestfailed", (request) =>
    console.error("Request failed:", request.url(), request.failure()),
  );
  await page.goto("/");
  await expect(page.getByText("欢迎回来")).toBeVisible();
  await page
    .getByRole("textbox", { name: "邮箱", exact: true })
    .fill(testConfig.adminEmail);
  await page
    .getByRole("textbox", { name: "密码", exact: true })
    .fill(testConfig.adminPassword);
  await page.screenshot({ path: "test-results/login.png" });
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await expect(
    page.getByRole("heading", { name: "一切，尽在掌握。" }),
  ).toBeVisible();
  await expect(page.getByText("dev-api-01", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换主题" }).click();
  await expect(page.locator('[data-theme="dark"]')).toBeVisible();
  await page.screenshot({
    path: "test-results/overview-dark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换主题" }).click();
  await page.locator("nav").getByRole("button", { name: "云账户" }).click();
  await expect(
    page.getByRole("heading", { name: "开发工作空间" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "接入账户" }).first().click();
  await page.getByLabel("服务主体 JSON").fill("not json");
  await page.getByRole("button", { name: "保存账户" }).click();
  await expect(
    page.getByText("JSON 格式不正确", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .locator("nav")
    .getByRole("button", { name: "虚拟机", exact: true })
    .click();
  await page.getByRole("button", { name: "dev-api-01" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("10.42.0.4")).toBeVisible();
  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.locator("nav").getByRole("button", { name: "订阅配额" }).click();
  await page.getByLabel("选择账户").click();
  await page.getByRole("option", { name: "开发工作空间" }).click();
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("区域 vCPU 总数")).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "资源浏览器" }).click();
  await page.getByLabel("选择账户").click();
  await page.getByRole("option", { name: "开发工作空间" }).click();
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(
    page.getByText("dev-api-01-azpanel", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "删除资源组" })).toBeDisabled();
  await page
    .locator("nav")
    .getByRole("button", { name: "虚拟机", exact: true })
    .click();
  await page.getByRole("button", { name: "创建虚拟机", exact: true }).click();
  await expect(
    page.getByText("当前为只读模式。", { exact: false }),
  ).toBeVisible();
  // Region and image lists are fetched live from the account instead of typed by hand.
  const region = page.getByLabel("区域");
  await expect(region).toBeEnabled();
  await region.click();
  await page.getByRole("option", { name: /East Asia/ }).click();
  const image = page.getByLabel("系统镜像");
  await expect(image).toBeEnabled();
  await image.click();
  await page
    .getByRole("option", { name: /Ubuntu 24\.04 LTS · server/ })
    .click();
  await page.getByRole("button", { name: "加载可用规格" }).click();
  await expect(page.getByLabel("虚拟机规格")).toContainText("B1s");
  await page.getByLabel("允许管理访问的来源 CIDR").fill("198.51.100.7/32");
  await page
    .getByLabel("RSA SSH 公钥")
    .fill("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ== test@example");
  // Preset configuration: save current settings and reload them later.
  await page.getByRole("button", { name: "保存为预设" }).click();
  await page.getByLabel("预设名称").fill("测试预设");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("预设已保存")).toBeVisible();
  const preset = page.getByRole("combobox", { name: "预设配置" });
  await expect(preset).toContainText("测试预设");
  await page.getByLabel("允许管理访问的来源 CIDR").fill("0.0.0.0/0");
  await preset.click();
  await page.getByRole("option", { name: "不使用预设" }).click();
  await preset.click();
  await page.getByRole("option", { name: /测试预设/ }).click();
  await expect(page.getByLabel("允许管理访问的来源 CIDR")).toHaveValue(
    "198.51.100.7/32",
  );
  await expect(
    page.getByRole("button", { name: "创建虚拟机", exact: true }),
  ).toBeDisabled();
  await page
    .locator("nav")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(page.getByText("工作空间成员", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加成员" }).click();
  await page.getByLabel("邮箱", { exact: true }).fill("member@example.test");
  await page.getByLabel("初始密码（至少 12 位）").fill("Test-member-password");
  await page.getByRole("button", { name: "创建成员", exact: true }).click();
  await expect(
    page.getByText("member@example.test", { exact: true }),
  ).toBeVisible();
  await page
    .locator("nav")
    .getByRole("button", { name: "概览", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "打开导航" })).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBe(true);
  await page.screenshot({
    path: "test-results/overview-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page
    .getByRole("presentation")
    .getByRole("button", { name: "虚拟机", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "虚拟机", exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("nav").getByRole("button", { name: "云账户" }).click();
  const syncResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/sync") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "同步资源", exact: true }).click();
  const syncResponse = await syncResponsePromise;
  expect(syncResponse.status()).toBe(200);
  expect(syncResponse.request().headers()["content-type"]).toBeUndefined();
  await page.locator("nav").getByRole("button", { name: "任务中心" }).click();
  await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible();

  const logoutResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/logout"),
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  expect((await logoutResponsePromise).status()).toBe(200);
  await expect(page.getByText("欢迎回来")).toBeVisible();
  expect(errors).toEqual([]);
});

test("register with an invite code and sign in", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("欢迎回来")).toBeVisible();
  await page.getByRole("button", { name: "使用邀请码注册" }).click();
  await expect(
    page.getByRole("heading", { name: "使用邀请码注册" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "邮箱", exact: true })
    .fill("brand-new@example.test");
  await page
    .getByRole("textbox", { name: "密码", exact: true })
    .fill("BrowserPass-1234");
  await page
    .getByRole("textbox", { name: "确认密码" })
    .fill("BrowserPass-1234");
  await page.getByRole("textbox", { name: "邀请码" }).fill("WRONG-CODE-0000");
  await page.getByRole("button", { name: "创建账户" }).click();
  await expect(page.getByText("邀请码无效")).toBeVisible();
  await page.getByRole("textbox", { name: "邀请码" }).fill("TEST-CODE-0001");
  await page.getByRole("button", { name: "创建账户" }).click();
  await expect(page.getByText("注册成功", { exact: false })).toBeVisible();
  await page
    .getByRole("textbox", { name: "密码", exact: true })
    .fill("BrowserPass-1234");
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await expect(
    page.getByRole("heading", { name: "一切，尽在掌握。" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

import { test, expect } from "@playwright/test";
import { testConfig } from "../fixtures.js";

test("mobile members, credit card, multi-delete and AI deployments work together", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3001/");
  await page
    .getByRole("textbox", { name: "邮箱", exact: true })
    .fill(testConfig.adminEmail);
  await page
    .getByRole("textbox", { name: "密码", exact: true })
    .fill(testConfig.adminPassword);
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await page.locator("nav").getByRole("button", { name: "云账户" }).click();
  await expect(
    page.getByRole("region", { name: "订阅额度", exact: true }),
  ).toContainText("76.5 USD");
  await expect(
    page.getByRole("region", { name: "订阅额度", exact: true }),
  ).toContainText("账单配置文件共享额度");

  await page.locator("nav").getByRole("button", { name: "资源浏览器" }).click();
  await page.getByLabel("选择账户").click();
  await page.getByRole("option", { name: "开发工作空间" }).click();
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page.getByRole("checkbox", { name: "全选资源组" }).check();
  await page.getByRole("button", { name: "删除所选资源组" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("输入「DELETE」确认")
    .fill("DELETE");
  await page.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByText(/occupied：资源组 occupied 非空/)).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "任务中心" }).click();
  await expect(
    page.locator(".task-result").filter({ hasText: "empty" }),
  ).toContainText("删除成功");
  await expect(
    page.locator(".task-result").filter({ hasText: "occupied" }),
  ).toContainText("protected-disk");

  await page.locator("nav").getByRole("button", { name: "AI 模型" }).click();
  const aiReads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/ai/"))
      aiReads.push(request.url());
  });
  await page.getByLabel("Azure 账户").click();
  await page.getByRole("option", { name: "开发工作空间" }).click();
  await expect(page.getByText("还没有部署模型")).toBeVisible();
  expect(aiReads.some((url) => /\/models\?|\/usages\?/.test(url))).toBe(false);
  let releaseUsage: () => void = () => {};
  const blockedUsage = new Promise<void>((resolve) => {
    releaseUsage = resolve;
  });
  await page.route("**/ai/usages?**", async (route) => {
    await blockedUsage;
    await route.continue();
  });
  await page.getByRole("button", { name: "部署模型", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("模型与版本").click();
  await page.getByRole("option", { name: /gpt-test/ }).click();
  await expect(dialog.getByText(/Azure 默认值：1/)).toBeVisible();
  await expect(dialog.getByLabel("容量单位")).toHaveValue("1");
  // Deliberately leave quota pending: the dialog must be usable independently.
  await expect(dialog.getByText(/正在后台读取配额/)).toBeVisible();
  await dialog.getByLabel("部署名称", { exact: true }).fill("browser-model");
  await dialog.getByLabel("输入部署名称确认").fill("browser-model");
  await dialog.getByRole("button", { name: "确认部署" }).click();
  releaseUsage();
  await expect(
    page.getByRole("heading", { name: "AI 模型管理" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "当前操作进度" }),
  ).toContainText("已完成", { timeout: 15000 });
  expect(new URL(page.url()).hash).toBe("#ai");

  await expect(page.getByRole("cell", { name: "browser-model" })).toBeVisible();
  await page.getByRole("button", { name: "删除部署", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("输入部署名称确认")
    .fill("browser-model");
  await page.getByRole("button", { name: "确认删除部署" }).click();
  await expect(
    page.getByRole("heading", { name: "AI 模型管理" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "当前操作进度" }),
  ).toContainText("已完成", { timeout: 15000 });
  await expect(page.getByRole("cell", { name: "browser-model" })).toHaveCount(
    0,
  );
  // Failed deployment stays on the same page and reports the server error.
  await page.getByRole("button", { name: "部署模型", exact: true }).click();
  await dialog.getByLabel("模型与版本").click();
  await page.getByRole("option", { name: /gpt-test/ }).click();
  await dialog.getByLabel("容量单位").fill("100");
  await dialog.getByLabel("部署名称", { exact: true }).fill("too-large");
  await dialog.getByLabel("输入部署名称确认").fill("too-large");
  await dialog.getByRole("button", { name: "确认部署" }).click();
  await expect(
    page.getByRole("region", { name: "当前操作进度" }),
  ).toContainText("容量不符合", { timeout: 15000 });
  expect(new URL(page.url()).hash).toBe("#ai");

  // Stay on the wizard while running, then open the submitted VM's management
  // details only after the task (including resource sync) succeeds.
  await page
    .locator("nav")
    .getByRole("button", { name: "虚拟机", exact: true })
    .click();
  await page.getByRole("button", { name: "创建虚拟机", exact: true }).click();
  const region = page.getByRole("combobox", { name: "区域" });
  await expect(region).toBeEnabled();
  await region.click();
  const list = page.getByRole("listbox");
  await expect(list.getByText("亚洲", { exact: true })).toBeVisible();
  await expect(list.getByText("欧洲", { exact: true })).toBeVisible();
  await expect(list.getByText("大洋洲", { exact: true })).toBeVisible();
  await expect(
    list.getByRole("option", { name: "Asia · asia", exact: true }),
  ).toHaveCount(0);
  const labels = await list.getByRole("option").allTextContents();
  expect(labels.indexOf("France Central · francecentral")).toBeLessThan(
    labels.indexOf("Australia East · australiaeast"),
  );
  await page
    .getByRole("option", { name: "Japan East · japaneast", exact: true })
    .click();
  const imageSelector = page.getByRole("combobox", { name: "系统镜像" });
  await expect(imageSelector).toBeEnabled();
  await imageSelector.click();
  await page
    .getByRole("option", { name: /Ubuntu 24\.04 LTS · server/ })
    .click();
  await page
    .getByRole("textbox", { name: "虚拟机名称", exact: true })
    .fill("browser-vm");
  await page
    .getByLabel("RSA SSH 公钥")
    .fill("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ== test@example");
  await page.getByLabel("允许管理访问的来源 CIDR").fill("192.0.2.1/32");
  await page.getByLabel("再次输入虚拟机名称确认").fill("browser-vm");
  let releaseTask: () => void = () => {};
  const taskGate = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  await page.route("**/api/tasks/*", async (route) => {
    await taskGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "创建虚拟机", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "当前操作进度" }),
  ).toContainText("browser-vm");
  await expect(
    page.getByRole("heading", { name: "创建虚拟机", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#create");
  // Editing while waiting must not change the target that the success callback opens.
  await page
    .getByRole("textbox", { name: "虚拟机名称", exact: true })
    .fill("edited-after-submit");
  releaseTask();
  await expect(
    page.getByRole("heading", { name: "虚拟机", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("browser-vm", { exact: true })).toBeVisible();
  await expect(detail.getByText("japaneast", { exact: true })).toBeVisible();
  const destination = new URLSearchParams(
    new URL(page.url()).hash.split("?")[1],
  );
  expect(destination.get("name")).toBe("browser-vm");
  expect(destination.get("group")).toBe("browser-vm-azpanel");
  await detail.getByRole("button", { name: "关闭详情" }).click();

  // A failed creation remains in the wizard with its entered values.
  await page.getByRole("button", { name: "创建虚拟机", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "系统镜像" })).toBeEnabled();
  await page
    .getByRole("textbox", { name: "虚拟机名称", exact: true })
    .fill("failed-browser-vm");
  await page.getByLabel("虚拟机规格").fill("Standard_NotAvailable");
  await page
    .getByLabel("RSA SSH 公钥")
    .fill("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ== test@example");
  await page.getByLabel("允许管理访问的来源 CIDR").fill("192.0.2.1/32");
  await page.getByLabel("再次输入虚拟机名称确认").fill("failed-browser-vm");
  await page.getByRole("button", { name: "创建虚拟机", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "当前操作进度" }),
  ).toContainText("所选规格不可用", { timeout: 15000 });
  expect(new URL(page.url()).hash).toBe("#create");
  await expect(
    page.getByRole("textbox", { name: "虚拟机名称", exact: true }),
  ).toHaveValue("failed-browser-vm");

  await page
    .locator("nav")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  const row = page
    .locator(".member-row")
    .filter({ hasText: testConfig.adminEmail });
  await expect(row).toBeVisible();
  const dimensions = await row.locator(".member-email").evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  expect(dimensions.width).toBeGreaterThan(180);
  expect(dimensions.height).toBeLessThan(40);
  expect(dimensions.whiteSpace).toBe("nowrap");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/members-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

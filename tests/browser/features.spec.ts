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
  await page.getByLabel("Azure 账户").click();
  await page.getByRole("option", { name: "开发工作空间" }).click();
  await page.getByRole("button", { name: "部署模型", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("模型与版本").click();
  await page.getByRole("option", { name: /gpt-test/ }).click();
  await dialog.getByLabel("部署名称", { exact: true }).fill("browser-model");
  await dialog.getByLabel("输入部署名称确认").fill("browser-model");
  await dialog.getByRole("button", { name: "确认部署" }).click();
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(
    page.locator(".task-row").filter({ hasText: "browser-model" }),
  ).toContainText("已完成", { timeout: 15000 });
  await page.locator("nav").getByRole("button", { name: "AI 模型" }).click();
  await page.getByLabel("Azure 账户").click();
  await page.getByRole("option", { name: "开发工作空间" }).click();
  await expect(page.getByRole("cell", { name: "browser-model" })).toBeVisible();
  await page.getByRole("button", { name: "删除部署", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("输入部署名称确认")
    .fill("browser-model");
  await page.getByRole("button", { name: "确认删除部署" }).click();
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();

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

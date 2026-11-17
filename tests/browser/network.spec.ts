import { test, expect } from "@playwright/test";
import { testConfig } from "../fixtures.js";

test("IPv6-only mode persists in presets and legacy presets restore their original public IPv4 mode", async ({
  page,
}) => {
  const legacySettings = {
    location: "eastasia",
    size: "Standard_B1s",
    image: {
      publisher: "Canonical",
      offer: "ubuntu-24_04-lts",
      sku: "server",
      version: "latest",
    },
    diskSize: 30,
    username: "azureuser",
    authentication: "ssh",
    sshKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ== test@example",
    password: "",
    customData: "",
  };
  await page.route("**/api/presets", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: [
        ...(await response.json()),
        ...[false, true].map((ipv6) => ({
          id: `legacy-${ipv6}`,
          name: ipv6 ? "旧双栈预设" : "旧 IPv4 预设",
          isDefault: false,
          settings: { ...legacySettings, ipv6 },
          updatedAt: 0,
        })),
      ],
    });
  });
  await page.goto("http://127.0.0.1:3000/");
  await page
    .getByRole("textbox", { name: "邮箱", exact: true })
    .fill(testConfig.adminEmail);
  await page
    .getByRole("textbox", { name: "密码", exact: true })
    .fill(testConfig.adminPassword);
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await page
    .locator("nav")
    .getByRole("button", { name: "虚拟机", exact: true })
    .click();
  await page.getByRole("button", { name: "创建虚拟机", exact: true }).click();
  const network = page.getByRole("combobox", { name: "网络协议" });
  const presets = page.getByRole("combobox", { name: "预设配置" });
  const v6 = "仅公网 IPv6（保留内网 IPv4）";
  await expect(network).toHaveText("IPv4");
  await expect(
    page.getByText("IPv4 · Standard 静态", { exact: true }),
  ).toBeVisible();
  for (const [preset, expected] of [
    ["旧 IPv4 预设", "IPv4"],
    ["旧双栈预设", "IPv4 + IPv6"],
  ]) {
    await network.click();
    await page.getByRole("option", { name: v6, exact: true }).click();
    await expect(
      page.getByText("仅 IPv6 · Standard 静态", { exact: true }),
    ).toBeVisible();
    await presets.click();
    await page.getByRole("option", { name: preset, exact: true }).click();
    await expect(network).toHaveText(expected);
  }
  await presets.click();
  await page.getByRole("option", { name: "不使用预设", exact: true }).click();
  await network.click();
  await page.getByRole("option", { name: v6, exact: true }).click();
  await expect(
    page.getByText(/不创建公网 IPv4；IPv6 地址本身免费/),
  ).toBeVisible();
  await expect(page.getByText(/连接端必须支持\s*IPv6/)).toBeVisible();
  await page.getByRole("button", { name: "保存为新预设" }).click();
  await page.getByLabel("预设名称").fill("仅公网 IPv6 测试预设");
  const save = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/api/presets"),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect((await save).postDataJSON().settings).toMatchObject({
    publicIpv4: false,
    ipv6: true,
  });
  await expect(presets).toContainText("仅公网 IPv6 测试预设");
  // Creating a second preset while the first is selected must POST, not PUT.
  await network.click();
  await page.getByRole("option", { name: "IPv4", exact: true }).click();
  await page.getByRole("button", { name: "保存为新预设" }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "新建预设" }),
  ).toBeVisible();
  await page.getByLabel("预设名称").fill("IPv4 独立预设");
  const second = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/presets"),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const secondPreset = await (await second).json();
  expect(secondPreset.settings).toMatchObject({
    publicIpv4: true,
    ipv6: false,
  });
  await expect(presets).toContainText("IPv4 独立预设");
  await page.getByRole("textbox", { name: "管理员用户名" }).fill("presetuser");
  await page.getByRole("button", { name: "更新当前预设" }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "更新预设" }),
  ).toBeVisible();
  const update = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`/api/presets/${secondPreset.id}`),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect((await (await update).json()).settings.username).toBe("presetuser");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const stored = await page.request.get("http://127.0.0.1:3000/api/presets");
  const independent = (await stored.json()).filter((preset: any) =>
    ["仅公网 IPv6 测试预设", "IPv4 独立预设"].includes(preset.name),
  );
  expect(independent).toHaveLength(2);
  expect(
    independent.find((preset: any) => preset.name === "仅公网 IPv6 测试预设")
      .settings,
  ).toMatchObject({ publicIpv4: false, ipv6: true, username: "azureuser" });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "系统镜像" })).toBeEnabled();
  await presets.click();
  await page
    .getByRole("option", { name: "仅公网 IPv6 测试预设", exact: true })
    .click();
  await expect(network).toHaveText(v6);
  await expect(page.getByRole("textbox", { name: "管理员用户名" })).toHaveValue(
    "azureuser",
  );
  await expect(
    page.getByText("仅 IPv6 · Standard 静态", { exact: true }),
  ).toBeVisible();
  await presets.click();
  await page
    .getByRole("option", { name: "IPv4 独立预设", exact: true })
    .click();
  await expect(network).toHaveText("IPv4");
  await expect(page.getByRole("textbox", { name: "管理员用户名" })).toHaveValue(
    "presetuser",
  );
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(presets).not.toContainText("IPv4 独立预设");
  await presets.click();
  await expect(
    page.getByRole("option", { name: "IPv4 独立预设", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("option", { name: "仅公网 IPv6 测试预设", exact: true })
    .click();
  await expect(network).toHaveText(v6);
});

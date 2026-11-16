import { test, expect } from "@playwright/test";
import { testConfig } from "../fixtures.js";

test("image retry stays below its field on desktop and mobile and reloads successfully", async ({
  page,
}) => {
  let imageReads = 0;
  await page.route("**/api/accounts/*/images?**", async (route) => {
    imageReads++;
    if (imageReads === 1) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: "服务器返回了无效响应，请检查连接后重试",
        }),
      });
    } else await route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
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

  const image = page.getByRole("combobox", { name: "系统镜像" });
  const retry = page.getByRole("button", { name: "重新加载镜像", exact: true });
  await expect(retry).toBeVisible();
  await expect(image).toBeDisabled();
  // The button must belong to the same grid item, not become its own third row.
  const imageCell = page.locator(".form-grid > div").filter({ has: image });
  await expect(
    imageCell.getByRole("button", { name: "重新加载镜像", exact: true }),
  ).toBeVisible();

  for (const [width, height, layout] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await retry.scrollIntoViewIfNeeded();
    const fieldBox = (await image.boundingBox())!;
    const buttonBox = (await retry.boundingBox())!;
    expect(buttonBox.x).toBeGreaterThanOrEqual(fieldBox.x - 1);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
      fieldBox.x + fieldBox.width + 1,
    );
    expect(buttonBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    expect(buttonBox.y - fieldBox.y - fieldBox.height).toBeLessThan(100);
    await page.screenshot({
      path: `test-results/create-image-error-${layout}.png`,
      fullPage: true,
    });
  }
  await retry.click();
  await expect(image).toBeEnabled();
  await expect(retry).toHaveCount(0);
  expect(imageReads).toBe(2);
});

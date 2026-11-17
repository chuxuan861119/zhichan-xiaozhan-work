import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { acceptAgentCliPolicy, expect, test } from "./helpers/workbench.js";

test("Agent CLI settings stay usable in short and narrow windows", async ({ workbench }, info) => {
  const originalHome = process.env.ZXW_HOME;
  // macOS Unix sockets require a shorter path than its default TMPDIR provides.
  const cliHome =
    process.platform === "darwin"
      ? await mkdtemp("/private/tmp/zxw-layout-")
      : join(workbench.root, "cli");
  process.env.ZXW_HOME = cliHome;
  const app = await (async () => {
    try {
      return await workbench.launchAllowMultipleInstances();
    } finally {
      if (originalHome === undefined) delete process.env.ZXW_HOME;
      else process.env.ZXW_HOME = originalHome;
    }
  })();
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "关闭欢迎提示", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "Agent CLI（实验功能）", exact: true }).click();
  const entry = settings.getByRole("checkbox", { name: "启用 Agent CLI", exact: true });
  const copy = settings.getByRole("button", { name: "复制 Agent 接入指令", exact: true });
  await expect(entry).toBeEnabled();
  await expect(copy).toBeDisabled();
  for (const size of [
    { width: 912, height: 472 },
    { width: 1093, height: 574 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    const overflow = await settings
      .locator(".settings-workspace-content")
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, `Agent CLI at ${size.width}`).toBeLessThanOrEqual(1);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath(`agent-cli-${size.width}.png`),
    });
  }
  await entry.click();
  const policy = page.getByRole("dialog", { name: "Agent CLI 使用协议与隐私说明", exact: true });
  await expect(entry).not.toBeChecked();
  await expect(policy.getByRole("button", { name: "同意并开启", exact: true })).toBeDisabled();
  for (const size of [
    { width: 912, height: 472 },
    { width: 1093, height: 574 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath(`agent-cli-policy-${size.width}.png`),
    });
    const bounds = await policy.boundingBox();
    if (!bounds) throw new Error("Policy dialog missing");
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height);
    expect(
      await policy.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  await policy.getByRole("button", { name: "暂不开启", exact: true }).click();
  await expect(policy).toBeHidden();
  await expect(entry).not.toBeChecked();
  await entry.click();
  await acceptAgentCliPolicy(page);
  await expect(entry).toBeChecked();
  await expect(copy).toBeEnabled();
  await settings.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(entry).toBeChecked();
  await entry.click();
  await expect(entry).not.toBeChecked();
  await expect(copy).toBeDisabled();
  await app.close();
  if (process.platform === "darwin") await rm(cliHome, { recursive: true, force: true });
});

test("settings routes remain within short laptop viewports", async ({ workbench }, info) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  for (const size of [
    { width: 912, height: 472 },
    { width: 1093, height: 574 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot();
    for (const name of [
      "默认模板",
      "页边距",
      "显示偏好",
      "启动与关闭",
      "编辑辅助",
      "快捷键",
      "AI模型配置",
      "AI 使用与隐私",
      "内容搜索",
      "存储位置",
      "自动保护",
      "数据迁移",
      "备份文件",
      "快照版本",
    ]) {
      if (["存储位置", "自动保护", "备份文件", "快照版本"].includes(name))
        await settings.getByRole("button", { name: "存储与备份", exact: true }).click();
      await settings.getByRole("button", { name, exact: true }).click();
      const surface = await settings.locator(".application-settings-dialog__surface").boundingBox();
      if (!surface) throw new Error("Settings surface missing");
      expect.soft(surface.y, name).toBeGreaterThanOrEqual(0);
      expect.soft(surface.y + surface.height, name).toBeLessThanOrEqual(size.height);
      const overflow = await settings
        .locator(".settings-workspace-content")
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect.soft(overflow, `${name} at ${size.width}: horizontal overflow`).toBeLessThanOrEqual(1);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`settings-${size.width}-${name}.png`),
      });
    }
  }
});

test("custom template editor keeps an editing area and save action on short displays", async ({
  workbench,
}, info) => {
  test.setTimeout(90_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "默认模板", exact: true }).click();
  await settings.getByRole("button", { name: "打开默认模板设置" }).click();
  const dialog = page.getByRole("dialog", { name: "默认模板设置", exact: true });
  await dialog.getByRole("button", { name: "新建自定义模板" }).click();
  for (const size of [
    { width: 912, height: 472 },
    { width: 1093, height: 574 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: info.outputPath(`template-${size.width}.png`) });
    const editor = await dialog.locator(".template-catalog__editor-viewport").boundingBox();
    const save = await dialog.getByRole("button", { name: "保存设置", exact: true }).boundingBox();
    if (!editor || !save) throw new Error("Template editor or save action missing");
    expect.soft(editor.height, `editor height at ${size.width}`).toBeGreaterThan(100);
    expect.soft(editor.x + editor.width).toBeLessThanOrEqual(size.width);
    expect.soft(editor.y + editor.height).toBeLessThanOrEqual(size.height);
    expect.soft(save.y + save.height).toBeLessThanOrEqual(size.height);
    await dialog
      .getByRole("textbox", { name: "编辑 权利要求书", exact: true })
      .fill("模板布局测试");
  }
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("AI model editor follows the settings layout without horizontal overflow", async ({
  workbench,
}, info) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "AI模型配置", exact: true }).click();
  await settings.getByRole("button", { name: "添加模型" }).first().click();
  await expect(settings.getByRole("heading", { name: "添加新模型" })).toBeVisible();
  const overflow = await settings
    .locator(".settings-workspace-content")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("settings-ai-model-editor.png") });
});

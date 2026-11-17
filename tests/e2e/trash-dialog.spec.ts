import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, _electron as electron, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: This hidden Electron fixture has no browser dependencies.
  page: async ({}, use) => {
    const userData = await mkdtemp(join(tmpdir(), "patent-trash-modal-"));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
      ),
    );
    const app = await electron.launch({
      args: [
        resolve("tests/e2e/fixtures/editor-typography-electron.cjs"),
        `--user-data-dir=${userData}`,
      ],
      env,
    });
    try {
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()),
        ),
      ).toBe(true);
      await use(await app.firstWindow());
    } finally {
      await app.close();
    }
  },
});
let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { entries: ["tests/e2e/fixtures/trash-dialog.html"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [process.cwd(), await realpath(resolve("node_modules"))] },
    },
  });
  await server.listen();
  url = `${server.resolvedUrls?.local[0]}tests/e2e/fixtures/trash-dialog.html`;
});
test.afterAll(async () => {
  await server?.close();
});
for (const width of [1440, 700, 420]) {
  test(`modal rows and footer fit at ${width}px`, async ({ page }) => {
    const height = width === 1440 ? 1080 : 800;
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(url);
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "回收站" });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw Error("missing bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(width > 680 ? 24 : 12);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - (width > 680 ? 24 : 12));
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 12);
    expect(await dialog.evaluate((node) => getComputedStyle(node).borderRadius)).toBe("12px");
    for (const checkbox of await dialog.getByRole("checkbox").all()) {
      const b = await checkbox.boundingBox();
      expect(b).not.toBeNull();
      if (b) expect(b.x + b.width).toBeLessThan(bounds.x + bounds.width);
    }
    expect(
      await page
        .locator(".trash-dialog__list")
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    for (const badge of await dialog.locator(".trash-dialog__protected").all()) {
      const positions = await badge.evaluate((node) => {
        const badgeBounds = node.getBoundingClientRect();
        const daysBounds = node.previousElementSibling!.getBoundingClientRect();
        return {
          badgeX: badgeBounds.x,
          daysRight: daysBounds.right,
          badgeCenterY: badgeBounds.y + badgeBounds.height / 2,
          daysCenterY: daysBounds.y + daysBounds.height / 2,
        };
      });
      expect(positions.badgeX).toBeGreaterThan(positions.daysRight);
      expect(Math.abs(positions.badgeCenterY - positions.daysCenterY)).toBeLessThan(4);
    }
    for (const name of ["恢复", "永久删除", "关闭"]) {
      const b = await dialog.getByRole("button", { name, exact: true }).boundingBox();
      if (!b) throw Error("button missing");
      expect(b.x + b.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    }
    if (width === 1440) {
      await page.getByRole("checkbox", { name: "选择 电池温控装置" }).check();
      await page.screenshot({ path: "test-results/trash-dialog-desktop.png" });
    }
  });
}
test("protects selected patents, restores mixed items and preserves the background scroll", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url);
  await page.locator("#library-position").evaluate((node) => {
    node.scrollTop = 200;
  });
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByRole("checkbox", { name: "全选回收站内容" }).check();
  await expect(page.getByRole("button", { name: "永久删除", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.getByText("回收站为空", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "回收站" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "回收站" })).toHaveCount(0);
  expect(await page.locator("#library-position").evaluate((node) => node.scrollTop)).toBe(200);
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toBeFocused();
});
test("confirmation cancel keeps the row and accepted deletion removes it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url);
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择 写作草稿" }).check();
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(
    page.getByText("永久删除“写作草稿”？此操作不可恢复。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "选择 写作草稿" })).toBeChecked();
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "选择 写作草稿" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "回收站" })).toBeVisible();
});

test("long titles and many rows scroll inside the modal with a fixed footer", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 520 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url + "?many");
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const list = page.locator(".trash-dialog__list");
  expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  const close = page.getByRole("button", { name: "关闭", exact: true });
  const before = await close.boundingBox();
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(await close.boundingBox()).toEqual(before);
  await expect(page.locator(".trash-dialog tbody tr")).toHaveCount(10);
  await page.getByRole("checkbox", { name: "全选当前页" }).check();
  await expect(page.getByText("已选择 10 项", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".trash-dialog tbody tr")).toHaveCount(10);
  await page.getByRole("checkbox", { name: "全选当前页" }).check();
  await expect(page.getByText("已选择 20 项", { exact: true })).toBeVisible();
  const jump = page.getByRole("textbox", { name: "跳转页码" });
  await jump.fill("4");
  await jump.press("Enter");
  await expect(page.locator(".trash-dialog tbody tr")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
  await expect(list).toHaveJSProperty("scrollTop", 0);
  expect(await list.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/trash-dialog-pagination.png" });
});
test("pagination fits a narrow modal", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url + "?many");
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "回收站" });
  const bounds = await dialog.boundingBox();
  if (!bounds) throw Error("missing dialog");
  for (const control of await dialog
    .locator(".trash-dialog__pagination button, .trash-dialog__pagination input")
    .all()) {
    const b = await control.boundingBox();
    if (!b) throw Error("missing pagination control");
    expect(b.x).toBeGreaterThanOrEqual(bounds.x);
    expect(b.x + b.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(b.y + b.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
test("restoring the last page moves to the remaining last page", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${url}?many`);
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const jump = page.getByRole("textbox", { name: "跳转页码" });
  await jump.fill("4");
  await jump.press("Enter");
  await page.getByRole("checkbox", { name: "全选当前页" }).check();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(jump).toHaveValue("3");
  await expect(page.getByText("共 30 项 · 每页 10 项")).toBeVisible();
  await expect(page.locator(".trash-dialog tbody tr")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
});
test("title search and sorting keep a large trash list responsive", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${url}?large`);
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await expect(page.locator(".trash-dialog tbody tr")).toHaveCount(10);
  await expect(page.getByRole("textbox", { name: "跳转页码" })).toHaveValue("1");
  const search = page.getByRole("searchbox", { name: "搜索回收站题目" });
  const started = Date.now();
  await search.fill("长标题文档 4999");
  await expect(page.locator(".trash-dialog tbody tr")).toHaveCount(1);
  const elapsed = Date.now() - started;
  console.log(`5002-item title search and rendering: ${elapsed}ms`);
  expect(elapsed).toBeLessThan(1500);
  await expect(page.getByRole("textbox", { name: "跳转页码" })).toHaveCount(0);
  await search.fill("正文摘要");
  await expect(page.getByText("未找到匹配的题目")).toBeVisible();
  await page.getByRole("button", { name: "清空搜索" }).click();
  await expect(page.locator(".trash-dialog tbody tr")).toHaveCount(10);
  await page.getByRole("button", { name: "按名称排序" }).click();
  await expect(page.locator(".trash-dialog thead th[aria-sort='ascending']")).toContainText("名称");
  await page.getByRole("button", { name: "按名称排序" }).click();
  await expect(page.locator(".trash-dialog thead th[aria-sort='descending']")).toContainText(
    "名称",
  );
  await page.screenshot({ path: "test-results/trash-dialog-search-sort.png" });
});

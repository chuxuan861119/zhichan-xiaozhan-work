import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, waitForMainWindow } from "./helpers/workbench.js";

test("first-use agreement, retained exits, offline documents and same-version persistence", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  const page = await waitForMainWindow(app, false);
  const gate = page.getByRole("dialog", { name: "软件使用协议与隐私政策确认", exact: true });
  await expect(gate).toBeVisible();
  await expect(gate.getByRole("checkbox")).not.toBeChecked();
  await expect(gate.getByRole("button", { name: "开始使用" })).toBeEnabled();
  const geometry = await gate.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const button = el.querySelector(".consent-start")!.getBoundingClientRect();
    const img = el.querySelector("img")!;
    return {
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
      buttonBottom: button.bottom,
      loaded: img.complete && img.naturalWidth > 0,
    };
  });
  expect(geometry.width).toBe(460);
  expect(geometry.height).toBeLessThanOrEqual(660);
  expect(geometry.loaded).toBe(true);
  expect(geometry.buttonBottom).toBeLessThan(geometry.bottom);
  await page.keyboard.press("Escape");
  await expect(gate).toBeVisible();
  await gate.getByRole("button", { name: "软件使用协议", exact: true }).click();
  const reader = page.getByRole("dialog", { name: "软件使用协议", exact: true });
  await expect(reader).toBeVisible();
  await expect(reader.locator("article section")).toHaveCount(10);
  await page.screenshot({ path: "output/agreement-reader-production.png" });
  await reader.getByRole("button", { name: "返回协议确认" }).click();
  await expect(reader).toBeHidden();
  await expect(page.locator(".consent-reader")).toHaveCount(0);
  await expect(gate.getByRole("button", { name: "软件使用协议", exact: true })).toBeFocused();
  await page.screenshot({ path: "output/agreement-production.png" });
  await page.setViewportSize({ width: 360, height: 520 });
  const narrow = await gate.evaluate((el) => ({
    panel: el.getBoundingClientRect().toJSON(),
    button: el.querySelector(".consent-start")?.getBoundingClientRect().toJSON(),
    width: innerWidth,
    height: innerHeight,
  }));
  expect(narrow.panel.left).toBeGreaterThanOrEqual(0);
  expect(narrow.panel.right).toBeLessThanOrEqual(narrow.width);
  expect(narrow.button?.bottom).toBeLessThanOrEqual(narrow.height);
  await page.screenshot({ path: "output/agreement-narrow-production.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const exit = await page.evaluate(async () => {
    const gate = document.querySelector(".agreement-gate")!;
    const overlay = gate.parentElement!;
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (overlay.getAttribute("data-motion") !== "exit") return;
        observer.disconnect();
        resolve({
          inert: overlay.hasAttribute("inert"),
          hidden: overlay.getAttribute("aria-hidden"),
          duration: getComputedStyle(overlay).animationDuration,
          workspaceBlocked: document.querySelector(".agreement-workspace")!.hasAttribute("inert"),
          text: gate.querySelector(".consent-start")!.textContent,
        });
      });
      observer.observe(overlay, { attributes: true });
      (gate.querySelector(".consent-start") as HTMLButtonElement).click();
    });
  });
  expect(exit).toMatchObject({
    inert: true,
    hidden: "true",
    workspaceBlocked: false,
    duration: "0.4s",
    text: "开始使用",
  });
  await expect(page.locator(".agreement-gate")).toHaveCount(0);
  const record = JSON.parse(
    await readFile(join(workbench.userData, "agreement-consent.json"), "utf8"),
  );
  expect(record.everStatisticsConsent).toBe(false);
  await app.close();
  const again = await workbench.launch();
  const next = await waitForMainWindow(again, false);
  await expect(next.locator(".agreement-workspace")).not.toHaveAttribute("inert", "");
  await expect(next.locator(".agreement-gate")).toHaveCount(0);
  async function checkHelpDocuments() {
    for (const title of ["软件使用协议", "隐私政策"]) {
      await next.getByRole("button", { name: "帮助", exact: true }).click();
      await next.getByRole("menuitem", { name: title, exact: true }).click();
      const reader = next.getByRole("dialog", { name: title, exact: true });
      await expect(reader).toBeVisible();
      const count = await reader.locator("article section").count();
      expect(count).toBeGreaterThanOrEqual(10);
      await reader.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(next.locator(".consent-reader")).toHaveCount(0);
    }
  }
  await checkHelpDocuments();
  await next.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = next.getByRole("dialog", { name: "新建专利", exact: true });
  await create.getByRole("textbox", { name: "专利名称" }).fill("协议入口验证专利");
  await create.getByRole("radio", { name: "发明", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(next.getByRole("tab", { name: "协议入口验证专利", exact: true })).toBeVisible();
  await checkHelpDocuments();
});

test("historical consent hides statistics on policy updates and refusal exits through close protection", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  const page = await waitForMainWindow(app, false);
  const state = await page.evaluate(() => window.patentApi.agreements!.read());
  expect(state.ok).toBe(true);
  if (!state.ok) throw new Error("read failed");
  await app.close();
  await writeFile(
    join(workbench.userData, "agreement-consent.json"),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: state.value.appVersion,
      termsVersion: "old",
      privacyVersion: state.value.policy.privacyVersion,
      statisticsNoticeVersion: state.value.statistics?.noticeVersion ?? null,
      everStatisticsConsent: true,
    }),
  );
  const updated = await workbench.launch();
  const next = await waitForMainWindow(updated, false);
  const gate = next.getByRole("dialog", { name: "软件使用协议与隐私政策确认", exact: true });
  await expect(gate).toBeVisible();
  await expect(gate.getByRole("checkbox")).toHaveCount(0);
  await next.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  const closing = updated.waitForEvent("close");
  await gate.getByRole("button", { name: "不同意并退出" }).click();
  await closing;
});

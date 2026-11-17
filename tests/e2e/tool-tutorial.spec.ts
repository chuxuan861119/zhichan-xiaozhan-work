/// <reference lib="dom" />

import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { createTutorialSession } from "../../src/main/tutorial/session.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import type { TutorialLessonId } from "../../src/shared/tutorial/model.js";
import { expect, test } from "./helpers/workbench.js";

declare global {
  interface Window {
    patentApi: PatentApi;
  }
}

async function exitByClick(page: Page, button: Locator) {
  await button.click({ noWaitAfter: true }).catch((cause: unknown) => {
    // Prompt process exit can close CDP before the mouse-up acknowledgement.
    // Callers still assert the actual child exit code / session-directory cleanup.
    if (!page.isClosed()) throw cause;
  });
}

async function course(page: Page, id: TutorialLessonId) {
  await page
    .locator(".tool-tutorial-coach")
    .getByRole("button", { name: "目录", exact: true })
    .click();
  const titles = {
    "clear-format": "清除多余格式",
    "dependent-claim": "插入从权",
    "sequential-number": "顺序编号",
    "custom-number": "自定义编号",
    "supplement-number": "增补编号",
    "invention-content": "转换成发明内容",
    embodiments: "转换成具体实施方式",
    "cad-label": "CAD 标号",
    "figure-sort": "附图排序",
  };
  const dialog = page.getByRole("dialog", { name: "快速工具教程", exact: true });
  await dialog.locator(".tool-tutorial-course").filter({ hasText: titles[id] }).click();
  await dialog.getByRole("button", { name: "开始这项练习", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "请确认", exact: true });
  if (await confirm.isVisible())
    await confirm.getByRole("button", { name: "确定", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".tool-tutorial-coach h2")).toHaveText(titles[id]);
  await expect(page.locator(".tool-tutorial-error")).toHaveCount(0);
}
async function selectWord(page: Page, keyword: string) {
  await page
    .getByRole("textbox", { name: "编辑 权利要求书", exact: true })
    .evaluate((root, word) => {
      const editor = (root as HTMLElement & { editor: Editor }).editor;
      let selected = false;
      editor.state.doc.descendants((node, pos) => {
        if (selected || !node.isText || !node.text) return;
        const start = node.text.indexOf(word);
        if (start < 0) return;
        editor.commands.setTextSelection({ from: pos + start, to: pos + start + word.length });
        selected = true;
      });
      if (!selected) throw new Error("Exercise keyword not found");
    }, keyword);
}

test("tutorial launch uses a second isolated process and preserves the normal library", async ({
  workbench,
}) => {
  test.setTimeout(100_000);
  const application = await workbench.launchAllowMultipleInstances();
  let childBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let childPage: Page | undefined;
  try {
    const page = await application.firstWindow();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
    await expect(welcome).toBeVisible();
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
    await expect
      .poll(async () => {
        const settings = await page.evaluate(() => window.patentApi.settings.read());
        return settings.ok && settings.value.welcomeCompleted;
      })
      .toBe(true);
    const before = await page.evaluate(async () => ({
      settings: await window.patentApi.settings.read(),
      patents: await window.patentApi.patents.list("active"),
    }));
    const rootsBefore = new Set(await readdir(tmpdir()));
    const entry = page.getByRole("button", { name: "快速工具教程", exact: true });
    const entryBounds = await entry.boundingBox();
    const helpBounds = await page
      .locator(".library-application-menu")
      .getByRole("button", { name: "帮助", exact: true })
      .boundingBox();
    expect(entryBounds && helpBounds && entryBounds.y + entryBounds.height <= helpBounds.y).toBe(
      true,
    );
    await page.screenshot({
      path: "test-results/tool-tutorial-library-entry.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "快速工具教程", exact: true }).click();
    const chooser = page.getByRole("dialog", { name: "快速工具教程", exact: true });
    await expect(chooser.locator(".tool-tutorial-course")).toHaveCount(9);
    await page.screenshot({
      path: "test-results/tool-tutorial-directory.png",
      animations: "disabled",
    });
    await chooser.getByRole("button", { name: "进入练习", exact: true }).click();
    await expect(chooser).toBeHidden({ timeout: 50_000 });
    const roots = (await readdir(tmpdir())).filter(
      (name) => name.startsWith("zxw-tutorial-") && !rootsBefore.has(name),
    );
    expect(roots).toHaveLength(1);
    const root = join(tmpdir(), roots[0]!);
    const port = Number(
      (await readFile(join(root, "userData", "DevToolsActivePort"), "utf8")).split("\n")[0],
    );
    childBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const child = childBrowser.contexts()[0]!.pages()[0]!;
    childPage = child;
    await expect(child.locator('[data-tool-tutorial="true"]')).toBeVisible();
    await expect(child.getByRole("tab", { name: "专利库", exact: true })).toHaveCount(0);
    await expect(child.getByRole("button", { name: "设置", exact: true })).toHaveCount(0);
    await expect(child.getByRole("button", { name: "IPC数据中心", exact: true })).toHaveCount(0);
    await expect(child.locator(".library-view")).toHaveCount(0);
    for (const name of ["新建", "导入", "导出", "打印"]) {
      await expect(
        child.getByRole("toolbar", { name: "常用工具" }).getByRole("button", { name, exact: true }),
      ).toHaveCount(0);
    }
    const first = await child.evaluate(() => window.patentApi.tutorial!.read());
    const again = await page.evaluate(() => window.patentApi.tutorial!.launch("figure-sort"));
    expect(again.ok).toBe(true);
    expect(await child.evaluate(() => window.patentApi.tutorial!.read())).toEqual(first);
    expect(
      await page.evaluate(async () => ({
        settings: await window.patentApi.settings.read(),
        patents: await window.patentApi.patents.list("active"),
      })),
    ).toEqual(before);
    await exitByClick(
      child,
      child.locator(".tool-tutorial-coach").getByRole("button", { name: "退出教学", exact: true }),
    );
    await expect.poll(async () => (await readdir(tmpdir())).includes(roots[0]!)).toBe(false);
    expect(
      await page.evaluate(async () => ({
        settings: await window.patentApi.settings.read(),
        patents: await window.patentApi.patents.list("active"),
      })),
    ).toEqual(before);
  } finally {
    await childPage
      ?.evaluate(() => window.patentApi.application.requestQuit?.())
      .catch(() => undefined);
    await childBrowser?.close().catch(() => undefined);
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
});

test("real tutorial tools validate results, reset exercises, and reject external operations", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  const session = await createTutorialSession("clear-format");
  const application = await workbench.launchAllowMultipleInstances(
    `--tool-tutorial=${session.root}`,
  );
  const child = application.process();
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const coach = page.locator(".tool-tutorial-coach");
    await expect(page.getByRole("textbox", { name: "编辑 说明书", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()),
      )
      .toBe("知产小栈Work · 快速工具教程");
    await expect(coach.getByRole("button", { name: "下一项", exact: true })).toBeDisabled();
    const denied = await page.evaluate(async () => [
      await window.patentApi.settings.update({ aiConnectionsEnabled: true }),
      await window.patentApi.application.relocateLibrary(),
      await window.patentApi.tutorial!.launch("clear-format"),
    ]);
    expect(
      denied.every((result) => !result.ok && result.error.code === "TUTORIAL_RESTRICTED"),
    ).toBe(true);
    await coach.getByRole("button", { name: "定位工具", exact: true }).click();
    await expect(page.locator(".tool-tutorial-ring")).toBeVisible();
    await page
      .locator(".patent-book-tools__clear-extra-formatting")
      .filter({ visible: true })
      .click();
    await expect(coach.locator(".tool-tutorial-result")).toHaveClass(/is-success/);
    await page.screenshot({ path: "test-results/tool-tutorial-coach.png", animations: "disabled" });
    const old = await page.evaluate(() => window.patentApi.tutorial!.read());
    await coach.getByRole("button", { name: "重新练习", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "请确认", exact: true });
    if (await confirm.isVisible())
      await confirm.getByRole("button", { name: "确定", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.patentApi.tutorial!.read()))
      .not.toEqual(old);
    await expect(coach.locator(".tool-tutorial-result")).not.toHaveClass(/is-success/);
    await course(page, "sequential-number");
    await selectWord(page, "底座");
    await page.locator('[data-numbering-help="sequential"]').filter({ visible: true }).click();
    await expect(coach.locator(".tool-tutorial-result")).toHaveClass(/is-success/);
    await course(page, "custom-number");
    await selectWord(page, "夹持板");
    await page.locator('[data-numbering-help="custom"]').filter({ visible: true }).click();
    await page.getByRole("textbox", { name: "自定义编号数字", exact: true }).fill("10");
    await page.getByRole("button", { name: "确认自定义编号", exact: true }).click();
    await expect(coach.locator(".tool-tutorial-result")).toHaveClass(/is-success/);
    await course(page, "supplement-number");
    await page
      .locator(".patent-book-tools__supplement-reference-numbers")
      .filter({ visible: true })
      .click();
    await expect(coach.locator(".tool-tutorial-result")).toHaveClass(/is-success/);
    await page.setViewportSize({ width: 820, height: 640 });
    await coach.getByRole("button", { name: "目录", exact: true }).click();
    await page.screenshot({
      path: "test-results/tool-tutorial-directory-narrow.png",
      animations: "disabled",
    });
    const chooser = page.getByRole("dialog", { name: "快速工具教程", exact: true });
    const bounds = await chooser.boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 820).toBe(true);
    expect(errors).toEqual([]);
    await chooser.getByRole("button", { name: "返回练习", exact: true }).click();
    await exitByClick(
      page,
      coach.locator("footer").getByRole("button", { name: "完成教学", exact: true }),
    );
    await expect.poll(() => child.exitCode).toBe(0);
  } finally {
    await Promise.resolve()
      .then(() => application.evaluate(({ app }) => app.exit(0)))
      .catch(() => undefined);
    if (child.exitCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await rm(session.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

for (const closeMethod of ["directory", "collapsed-coach", "native-window"] as const) {
  test(`tutorial exits cleanly through ${closeMethod} without save prompts`, async ({
    workbench,
  }) => {
    const session = await createTutorialSession("clear-format");
    const application = await workbench.launchAllowMultipleInstances(
      `--tool-tutorial=${session.root}`,
    );
    const child = application.process();
    try {
      const page = await application.firstWindow();
      await expect(page.locator(".tool-tutorial-coach h2")).toHaveText("清除多余格式");
      await expect(page.getByRole("textbox", { name: "编辑 说明书", exact: true })).toBeVisible();
      if (closeMethod === "directory") {
        await page.getByRole("button", { name: "课程目录", exact: true }).click();
        await exitByClick(
          page,
          page.getByRole("button", { name: "关闭快速工具教程", exact: true }),
        );
      } else if (closeMethod === "collapsed-coach") {
        await page.getByRole("button", { name: "折叠练习引导", exact: true }).click();
        await exitByClick(page, page.getByRole("button", { name: "关闭教程", exact: true }));
      } else {
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.close(),
        );
      }
      await expect.poll(() => child.exitCode).toBe(0);
    } finally {
      await Promise.resolve()
        .then(() => application.evaluate(({ app }) => app.exit(0)))
        .catch(() => undefined);
      if (child.exitCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await rm(session.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}

test("dependent claims, both converted drafts, CAD labels, and figure sorting use the actual tools", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const session = await createTutorialSession("dependent-claim");
  const application = await workbench.launchAllowMultipleInstances(
    `--tool-tutorial=${session.root}`,
  );
  const child = application.process();
  try {
    await application.evaluate(({ clipboard }) => {
      let data = { text: "", html: "" };
      Object.defineProperty(clipboard, "write", {
        value: (value: typeof data) => {
          data = value;
        },
      });
      Object.defineProperty(clipboard, "writeText", {
        value: (text: string) => {
          data = { text, html: "" };
        },
      });
      Object.defineProperty(clipboard, "readText", { value: () => data.text });
      Object.defineProperty(clipboard, "readHTML", { value: () => data.html });
    });
    const page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const coach = page.locator(".tool-tutorial-coach");
    const claims = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    await expect(claims).toBeVisible();
    await claims.evaluate((root) => {
      const editor = (root as HTMLElement & { editor: Editor }).editor;
      editor.commands.focus("end");
    });
    await page
      .locator(".patent-book-tools__insert-dependent-claim")
      .filter({ visible: true })
      .click();
    await expect(coach.locator(".tool-tutorial-result")).toHaveClass(/is-success/);

    for (const [id, title] of [
      ["invention-content", "发明内容"],
      ["embodiments", "具体实施方式"],
    ] as const) {
      await course(page, id);
      await page.locator(".claims-description-tool > button").filter({ visible: true }).click();
      await page
        .locator(".claims-description-tool__panel")
        .getByRole("button", { name: title, exact: true })
        .click();
      await page
        .getByRole("dialog", { name: `${title}预览`, exact: true })
        .getByRole("button", { name: "复制并跳转", exact: true })
        .click();
      await expect(coach.locator(".tool-tutorial-result")).not.toHaveClass(/is-success/);
      const copied = await application.evaluate(({ clipboard }) => ({
        text: clipboard.readText(),
        html: clipboard.readHTML(),
      }));
      const description = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
      await description.evaluate((root, heading) => {
        const editor = (root as HTMLElement & { editor: Editor }).editor;
        let after = -1;
        editor.state.doc.forEach((node, pos) => {
          if (after >= 0) return;
          if (node.textContent === heading) after = pos + node.nodeSize + 1;
        });
        if (after < 0) throw new Error("Target chapter missing");
        editor.commands.setTextSelection(after);
        editor.commands.focus();
      }, title);
      await description.evaluate((root, data) => {
        const transfer = new DataTransfer();
        transfer.setData("text/plain", data.text);
        transfer.setData("text/html", data.html);
        root.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
        );
      }, copied);
      await expect(coach.locator(".tool-tutorial-result")).toHaveClass(/is-success/);
    }
    await course(page, "cad-label");
    await page.locator(".cad-markup-entry").filter({ visible: true }).click();
    const cad = page.getByRole("region", { name: "CAD标号", exact: true });
    await expect(cad).toBeVisible();
    await expect(cad.locator('input[type="file"]')).toBeDisabled();
    await cad.getByRole("button", { name: "标号", exact: true }).click();
    const canvas = cad.getByRole("application", { name: "CAD标号画布" });
    for (const point of [
      { x: 200, y: 200 },
      { x: 500, y: 150 },
    ]) {
      const position = await canvas.evaluate((svg, p) => {
        const matrix = (svg as SVGSVGElement).getScreenCTM();
        if (!matrix) throw new Error("Canvas unavailable");
        const q = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        return { x: q.x, y: q.y };
      }, point);
      await page.mouse.click(position.x, position.y);
    }
    await expect(canvas.locator("[data-annotation]")).toHaveCount(1);
    await expect(coach.locator(".tool-tutorial-result")).toHaveClass(/is-success/);
    await page.screenshot({ path: "test-results/tool-tutorial-cad.png", animations: "disabled" });
    await course(page, "figure-sort");
    await page.locator(".drawing-sort-button").filter({ visible: true }).click();
    const figures = page.locator("article.drawing-pair-row");
    await expect(figures).toHaveCount(3);
    await figures.first().dragTo(figures.last());
    await expect(coach.locator(".tool-tutorial-result")).toHaveClass(/is-success/);
    await page.screenshot({
      path: "test-results/tool-tutorial-sorting.png",
      animations: "disabled",
    });
    expect(errors).toEqual([]);
    await exitByClick(
      page,
      coach
        .locator(".tool-tutorial-coach-actions")
        .getByRole("button", { name: "完成教学", exact: true }),
    );
    await expect.poll(() => child.exitCode).toBe(0);
  } finally {
    await Promise.resolve()
      .then(() => application.evaluate(({ app }) => app.exit(0)))
      .catch(() => undefined);
    if (child.exitCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await rm(session.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

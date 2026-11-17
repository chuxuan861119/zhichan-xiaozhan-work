import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import type {} from "@tiptap/extension-table";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

// This fixture creates a default fit-page, three-column table. Saving materializes
// its implicit defaults; retain every other attribute/content field in comparison.
function materializeFixtureDefaults(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, node) => {
      if (!node?.attrs || typeof node.type !== "string") return node;
      const attrs = { ...node.attrs };
      if (node.type === "table") attrs.columnWidthsMm ??= [55, 55, 55];
      if (node.type === "tableCell") {
        attrs.colwidth ??= [208];
        for (const edge of ["borderTop", "borderRight", "borderBottom", "borderLeft"])
          attrs[edge] ??= attrs.borderStyle;
      }
      if (node.type === "paragraph") attrs.textAlign ??= "left";
      return { ...node, attrs };
    }),
  );
}

test("@performance mixed dual documents survive queued bursts, composition and large pasted numbers", async ({
  workbench,
}) => {
  test.skip(
    process.env.PATENT_WORKBENCH_E2E_BACKGROUND !== "1",
    "Requires hidden isolated windows",
  );
  test.setTimeout(180_000);
  const name = "双显组字压力回归";
  const patent = createBlankPatent({ patentType: "invention", name });
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("Missing description");
  const paragraph = createBlankDocument("fixture").content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  description.document.content = Array.from({ length: 900 }, (_, index) => ({
    ...structuredClone(paragraph),
    id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    content: [
      {
        type: "text" as const,
        text: "本发明提供一种用于压力测试的虚构机械装置，包含连接机构、控制组件以及传动结构。",
        marks: [],
      },
    ],
  }));
  const source = join(workbench.root, "mixed-pressure.patdoc");
  await writePatdoc(source, { patent, assets: [] });
  let app = await workbench.launchAllowMultipleInstances();
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.name);
      console.error(error.stack);
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.getByRole("button", { name: "关闭欢迎提示", exact: true }).click();
    const cpuRate = Number(process.env.PATENT_WORKBENCH_PRESSURE_CPU_RATE ?? 1);
    if (cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, source);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page
      .getByRole("dialog", { name: "PATDOC 导入须知", exact: true })
      .getByRole("button", { name: "继续导入", exact: true })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await expect(editor).toBeVisible();
    // Advertise a maximized layout without activating any native test window.
    await app.evaluate(({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows()[0];
      if (!window) throw new Error("Missing window");
      Object.defineProperty(window, "isMaximized", { value: () => true });
      window.setSize(1920, 1080);
      window.emit("maximize");
    });
    await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
    await page.getByRole("menuitem", { name: "权／说" }).click();
    await expect(page.getByRole("region", { name: "同屏双文档工作区" })).toBeVisible();
    const claims = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    await claims.click();
    await claims.evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/plain", "\n20260907. 粘贴的日期编号。\n");
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(claims).toContainText("20260907.");
    await editor.evaluate((element) => {
      const current = (element as HTMLElement & { editor: Editor }).editor;
      current.commands.setTextSelection(2);
      current.commands.insertContent({
        type: "inlineMath",
        attrs: { latex: "x^2", formulaKind: "math" },
      });
      current.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: false });
    });
    await expect(editor.locator("table")).toHaveCount(1);
    const burstTimes: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      burstTimes.push(
        await editor.evaluate((element, round) => {
          const current = (element as HTMLElement & { editor: Editor }).editor;
          current.commands.setTextSelection(current.state.doc.content.size - 1);
          const started = performance.now();
          // More than the 32-entry echo window, before any save acknowledgement can arrive.
          for (let i = 0; i < 40; i += 1) current.commands.insertContent(`续${round}`);
          return performance.now() - started;
        }, round),
      );
      await editor.focus();
      // Chromium's real composition pipeline; not a claim of OS candidate-window testing.
      await cdp.send("Input.imeSetComposition", {
        text: "zhong",
        selectionStart: 5,
        selectionEnd: 5,
      });
      await cdp.send("Input.imeSetComposition", {
        text: "中文",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await cdp.send("Input.insertText", { text: "中文输入" });
      await expect(editor).toContainText("中文输入");
      await page.getByRole("button", { name: "交换左右文档" }).click();
    }
    const descriptionJson = await editor.evaluate((element) =>
      (element as HTMLElement & { editor: Editor }).editor.getJSON(),
    );
    const claimsJson = await claims.evaluate((element) =>
      (element as HTMLElement & { editor: Editor }).editor.getJSON(),
    );
    const typedText = await editor.textContent();
    for (let round = 0; round < 4; round += 1)
      expect(typedText?.split(`续${round}`).length).toBe(41);
    expect(typedText?.split("中文输入").length).toBe(5);
    await expect(page.locator(".status-bar")).toContainText("已保存", { timeout: 90_000 });
    expect(errors).toEqual([]);
    await expect(page.getByRole("heading", { name: "编辑界面发生错误" })).toHaveCount(0);
    console.log(JSON.stringify({ burstTimes }));
    await app.close();
    app = await workbench.launchAllowMultipleInstances();
    page = await app.firstWindow();
    if (!(await page.getByRole("tab", { name: "说明书", exact: true }).isVisible()))
      await page.getByRole("article", { name, exact: true }).dblclick();
    for (const [label, expected] of [
      ["说明书", descriptionJson],
      ["权利要求书", claimsJson],
    ] as const) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      const reopened = page.getByRole("textbox", { name: `编辑 ${label}`, exact: true });
      await expect(reopened).toBeVisible();
      const actual = await reopened.evaluate((element) =>
        (element as HTMLElement & { editor: Editor }).editor.getJSON(),
      );
      expect(materializeFixtureDefaults(actual)).toEqual(materializeFixtureDefaults(expected));
    }
  } finally {
    await app.close();
  }
});

test("@performance rich long-document input keeps live counts, undo and durable content", async ({
  workbench,
}) => {
  test.skip(
    process.env.PATENT_WORKBENCH_E2E_BACKGROUND !== "1",
    "Pressure tests must not activate a desktop window",
  );
  test.setTimeout(180_000);
  const name = "复杂长文档输入回归";
  const patent = createBlankPatent({ patentType: "invention", name });
  const book = patent.books.find((candidate) => candidate.kind === "description");
  if (!book) throw new Error("Missing description");
  book.document.content = createBlankDocument("fixture").content;
  const source = join(workbench.root, "pressure.patdoc");
  await writePatdoc(source, { patent, assets: [] });
  let app = await workbench.launchAllowMultipleInstances();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.name);
      console.error(error.stack);
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.getByRole("button", { name: "关闭欢迎提示", exact: true }).click();
    const cpuRate = Number(process.env.PATENT_WORKBENCH_PRESSURE_CPU_RATE ?? 1);
    if (cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, source);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page
      .getByRole("dialog", { name: "PATDOC 导入须知", exact: true })
      .getByRole("button", { name: "继续导入", exact: true })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await expect(editor).toBeVisible();
    await editor.click();
    const pasteTimes: number[] = [];
    for (let batch = 0; batch < 6; batch += 1) {
      const started = Date.now();
      await editor.evaluate((element) => {
        const data = new DataTransfer();
        data.setData("text/plain", "压力测试");
        data.setData(
          "text/html",
          Array.from({ length: 330 }, (_, index) =>
            index % 15 === 0
              ? "<h2>背景技术</h2>"
              : '<p>本发明提供<b>一种测试装置</b><span style="color:red">验证输入性能。</span></p>',
          ).join(""),
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      pasteTimes.push(Date.now() - started);
      for (let i = 0; i < 3; i += 1) await page.keyboard.insertText("输入");
    }
    const before = await editor.evaluate((element) => element.textContent ?? "");
    expect(before.length).toBeGreaterThan(30_000);
    const profiling = process.env.PATENT_WORKBENCH_PRESSURE_PROFILE === "1";
    if (profiling) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    const typingTimes: number[] = [];
    await editor.evaluate((element) => {
      const samples: number[] = [];
      const current = (element as HTMLElement & { editor: Editor }).editor;
      let started: number | null = null;
      const onInput = () => {
        started = performance.now();
      };
      const onUpdate = () => {
        if (started !== null) samples.push(performance.now() - started);
        started = null;
      };
      element.addEventListener("beforeinput", onInput);
      current.on("update", onUpdate);
      Object.assign(element, {
        pressureTiming: {
          samples,
          dispose: () => {
            element.removeEventListener("beforeinput", onInput);
            current.off("update", onUpdate);
          },
        },
      });
    });
    for (let i = 0; i < 30; i += 1) {
      const started = Date.now();
      await page.keyboard.insertText("测");
      typingTimes.push(Date.now() - started);
      // Read directly, without retry/sleep: counts must reflect the finished edit.
      const counts = await editor.evaluate((element) => ({
        expected: [...(element.textContent ?? "")].filter((c) => !/\p{White_Space}/u.test(c))
          .length,
        status: element.ownerDocument.querySelector(".status-bar")?.textContent,
      }));
      expect(counts.status).toContain(`字数：${counts.expected}`);
    }
    const inputUpdateTimes = await editor.evaluate((element) => {
      const timing = (
        element as HTMLElement & {
          pressureTiming: { samples: number[]; dispose(): void };
        }
      ).pressureTiming;
      timing.dispose();
      return timing.samples;
    });
    if (profiling) {
      const { profile } = await cdp.send("Profiler.stop");
      await test.info().attach("renderer-input-profile", {
        body: JSON.stringify(profile),
        contentType: "application/json",
      });
      const counts = new Map<number, number>();
      profile.samples?.forEach((id, index) => {
        counts.set(id, (counts.get(id) ?? 0) + (profile.timeDeltas?.[index] ?? 0));
      });
      console.log(
        JSON.stringify(
          profile.nodes
            .map((node) => ({
              name: node.callFrame.functionName,
              line: node.callFrame.lineNumber,
              ms: (counts.get(node.id) ?? 0) / 1000,
            }))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 20),
        ),
      );
    }
    // New undo group, inserted in the middle rather than at the document tail.
    await editor.evaluate((element) => {
      const editor = (element as HTMLElement & { editor: Editor }).editor;
      editor.commands.setTextSelection(3);
      editor.commands.insertContent("中间位置");
    });
    const finalText = await editor.textContent();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    expect(await editor.textContent()).toBe(finalText);
    await editor.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    expect(await editor.textContent()).not.toBe(finalText);
    await editor.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
    expect(await editor.textContent()).toBe(finalText);
    await expect(page.locator(".status-bar")).toContainText("已保存", { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "编辑界面发生错误" })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(inputUpdateTimes).toHaveLength(30);
    console.log(
      JSON.stringify({ pasteTimes, typingTimes, inputUpdateTimes, characters: finalText?.length }),
    );
    // Generous environment-independent stall guard; measured timings are reported
    // separately, not advertised as a guarantee for every Windows device.
    expect(Math.max(...pasteTimes)).toBeLessThan(5_000);
    expect(typingTimes.sort((a, b) => a - b)[28]).toBeLessThan(1_000);
    await app.close();
    app = await workbench.launchAllowMultipleInstances();
    page = await app.firstWindow();
    const reopened = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    if (!(await reopened.isVisible())) {
      await page.getByRole("article", { name, exact: true }).dblclick();
      await page.getByRole("tab", { name: "说明书", exact: true }).click();
    }
    await expect(reopened).toBeVisible();
    expect(await reopened.textContent()).toBe(finalText);
  } finally {
    await app.close();
  }
});

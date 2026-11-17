import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { DEFAULT_PAGE_SETTINGS } from "../../src/shared/document/defaults.js";
import { insertedFigureWidthMm } from "../../src/shared/patent/figure-insertion-size.js";
import { openDrawingEntry } from "./helpers/drawing-entry.js";

import { expect, test } from "./helpers/workbench.js";

function readCircuitModel(source: string) {
  const document = new DOMParser().parseFromString(source, "application/xml");
  const cells = [...document.getElementsByTagName("mxCell")];
  const vertices = cells
    .filter((cell) => cell.getAttribute("vertex") === "1")
    .map((cell) => {
      const geometry = cell.getElementsByTagName("mxGeometry")[0];
      return {
        id: cell.getAttribute("id") ?? "",
        style: cell.getAttribute("style") ?? "",
        x: Number(geometry?.getAttribute("x") ?? 0),
        y: Number(geometry?.getAttribute("y") ?? 0),
        width: Number(geometry?.getAttribute("width") ?? 0),
        height: Number(geometry?.getAttribute("height") ?? 0),
      };
    });
  const edges = cells
    .filter((cell) => cell.getAttribute("edge") === "1")
    .map((cell) => {
      const style = cell.getAttribute("style") ?? "";
      const geometry = cell.getElementsByTagName("mxGeometry")[0];
      const points = geometry
        ? [...geometry.getElementsByTagName("mxPoint")]
            .filter((point) => point.parentNode?.nodeName === "Array")
            .map((point) => ({
              x: Number(point.getAttribute("x") ?? 0),
              y: Number(point.getAttribute("y") ?? 0),
            }))
        : [];
      return {
        id: cell.getAttribute("id") ?? "",
        source: cell.getAttribute("source") ?? "",
        target: cell.getAttribute("target") ?? "",
        style,
        constraints: style
          .split(";")
          .filter((entry) => /^(?:entry|exit)[XY]=/u.test(entry))
          .sort(),
        points,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return { vertices, edges };
}

async function currentDrawioFrame(page: import("@playwright/test").Page) {
  await expect(page.getByTitle("流程图编辑器")).toBeVisible();
  await expect(page.getByTitle("流程图编辑器")).not.toHaveAttribute("inert", "");
  const frame = await expect
    .poll(
      () =>
        page
          .frames()
          .filter((candidate) => candidate.url().endsWith("/embed.html"))
          .at(-1) ?? null,
    )
    .not.toBeNull()
    .then(() =>
      page
        .frames()
        .filter((candidate) => candidate.url().endsWith("/embed.html"))
        .at(-1),
    );
  if (!frame) throw new Error("draw.io 编辑 frame 未加载");
  return frame;
}

async function openFlowchartProjectMenu(page: import("@playwright/test").Page) {
  const menu = page.getByRole("menu", { name: "流程图工程列表" });
  await expect
    .poll(async () => {
      if (await menu.isVisible()) return true;
      const frames = page
        .frames()
        .filter((candidate) => candidate.url().endsWith("/embed.html"))
        .reverse();
      for (const frame of frames) {
        const button = frame.getByRole("button", { name: "工程列表" });
        if (!(await button.isVisible().catch(() => false))) continue;
        await button.click().catch(() => undefined);
        if (await menu.isVisible().catch(() => false)) return true;
      }
      return false;
    })
    .toBe(true);
  return menu;
}

async function renameCurrentFlowchart(page: import("@playwright/test").Page, name: string) {
  await chooseDrawioFileProjectAction(page, "重命名当前流程图");
  const dialog = page.getByRole("dialog", { name: "重命名流程图工程" });
  await dialog.getByRole("textbox", { name: "工程名称" }).fill(name);
  await dialog.getByRole("button", { name: "确认重命名" }).click();
  await expect(dialog).not.toBeVisible();
  const refreshedMenu = await openFlowchartProjectMenu(page);
  await expect(
    refreshedMenu.locator('[role="menuitemradio"][aria-checked="true"]').filter({ hasText: name }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭流程图工程列表" }).click();
  await expect(refreshedMenu).not.toBeVisible();
}

async function chooseDrawioFileProjectAction(page: import("@playwright/test").Page, name: string) {
  const frame = await currentDrawioFrame(page);
  const editorBox = await page.getByTitle("流程图编辑器").boundingBox();
  const fileMenu = frame.locator(".geMenubarContainer").getByText("文件", { exact: true });
  const fileMenuBox = await fileMenu.boundingBox();
  if (!editorBox || !fileMenuBox) throw new Error("流程图文件菜单坐标不可用");
  await page.mouse.click(
    editorBox.x + fileMenuBox.x + fileMenuBox.width / 2,
    editorBox.y + fileMenuBox.y + fileMenuBox.height / 2,
  );
  if ((await frame.locator(".mxPopupMenu:visible").count()) === 0) {
    await fileMenu.evaluate((element) => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        element.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1 }),
        );
      }
    });
  }
  const item = frame.locator(".mxPopupMenu:visible tr").filter({ hasText: name }).first();
  await expect(item).toBeVisible();
  await item.click();
}

async function clickDrawioToolbarAction(page: import("@playwright/test").Page, actionName: string) {
  const dialogName =
    actionName === "导出至电脑"
      ? "导出至电脑"
      : actionName === "替换附图"
        ? "替换说明书附图"
        : "插入到说明书附图";
  const dialog = page.getByRole("dialog", { name: dialogName });
  await expect
    .poll(async () => {
      if (await dialog.isVisible().catch(() => false)) return true;
      const frame = await currentDrawioFrame(page).catch(() => null);
      if (!frame) return false;
      const action = frame.getByRole("button", { name: actionName, exact: true });
      if (!(await action.isVisible().catch(() => false))) return false;
      await action.click().catch(() => undefined);
      return dialog.isVisible().catch(() => false);
    })
    .toBe(true);
}

function isDrawioShortcutNotation(value: string): boolean {
  const namedKey =
    /^(?:F(?:[1-9]|1[0-2])|Mousewheel|Enter|Escape|Delete|Backspace|Tab|Space|Home|End|PageUp|PageDown)$/u;
  const chord =
    /^(?:Ctrl|Alt|Shift)(?:\+(?:Ctrl|Alt|Shift))*(?:\+(?:[A-Z]|Mousewheel|Enter|Escape|Delete|Backspace|Tab|Space|Home|End|PageUp|PageDown|SLASH|-)|-)$/u;
  const normalized = value.replace(/\s+/gu, "").replaceAll("+/", "+SLASH/");
  return normalized.split("/").every((part) => namedKey.test(part) || chord.test(part));
}

async function expectVisibleDrawioUiLocalized(frame: import("@playwright/test").Frame) {
  const findings = await frame.locator("body").evaluate((body) => {
    const approved = new Set(["draw.io", "SVG", "PDF", "PNG", "JPEG", "XML"]);
    const isShortcut = (value: string) => {
      const namedKey =
        /^(?:F(?:[1-9]|1[0-2])|Mousewheel|Enter|Escape|Delete|Backspace|Tab|Space|Home|End|PageUp|PageDown)$/u;
      const chord =
        /^(?:Ctrl|Alt|Shift)(?:\+(?:Ctrl|Alt|Shift))*(?:\+(?:[A-Z]|Mousewheel|Enter|Escape|Delete|Backspace|Tab|Space|Home|End|PageUp|PageDown|SLASH|-)|-)$/u;
      const normalized = value.replace(/\s+/gu, "").replaceAll("+/", "+SLASH/");
      return normalized.split("/").every((part) => namedKey.test(part) || chord.test(part));
    };
    const values = new Set<string>();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node as HTMLElement;
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (
        element instanceof HTMLImageElement &&
        (!element.complete || element.naturalWidth === 0)
      ) {
        continue;
      }
      const containsTemplateOrDiagramContent = Boolean(
        element.closest(".geItem, .geDiagramContainer"),
      );
      const directText = containsTemplateOrDiagramContent
        ? ""
        : [...element.childNodes]
            .filter((child) => child.nodeType === Node.TEXT_NODE)
            .map((child) => child.textContent ?? "")
            .join(" ");
      for (const value of [directText, element.title, element.getAttribute("aria-label")]) {
        let normalized = value
          ?.replace(/\bS\d+\b/gu, "")
          .replace(/#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b/giu, "")
          .replace(/\(([^()]*)\)/gu, (whole, shortcut: string) =>
            isShortcut(shortcut) ? "" : whole,
          )
          .replace(/\s+/gu, " ")
          .trim();
        if (
          !normalized ||
          /(?:https?:|data:|blob:|patent-diagram:)/iu.test(normalized) ||
          /^light-dark\(#[0-9a-f]{6},\s*#[0-9a-f]{6}\)$/iu.test(normalized)
        )
          continue;
        if (element.matches(".gePageTab")) {
          normalized = normalized.replace(/ \([A-Za-z0-9_-]+\) \[\d+\]$/u, "");
        }
        if (isShortcut(normalized)) {
          continue;
        }
        for (const match of normalized.matchAll(/[A-Za-z]+(?:\.[A-Za-z]+)?/gu)) {
          const end = (match.index ?? 0) + match[0].length;
          const before = normalized.slice(0, match.index ?? 0);
          const isShortcutModifier =
            /^(?:Ctrl|Alt|Shift)$/u.test(match[0]) && normalized[end] === "+";
          const isShortcutKey = /(?:Ctrl|Alt|Shift)\s*\+\s*$/u.test(before);
          if (isShortcutModifier || isShortcutKey) continue;
          if (!approved.has(match[0])) {
            values.add(
              `${match[0]} ← ${normalized} [${element.tagName.toLowerCase()} title=${element.getAttribute("title") ?? ""} aria-label=${element.getAttribute("aria-label") ?? ""}]`,
            );
          }
        }
      }
    }
    return [...values].sort();
  });
  expect(findings, `draw.io 可见界面出现未批准英文：\n${findings.join("\n")}`).toEqual([]);
}

test("opens the local flowchart workspace from a normal patent", async ({ workbench }) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const createDialog = page.getByRole("dialog", { name: "新建专利" });
    await createDialog.getByRole("textbox", { name: "专利名称" }).fill("流程图兼容性测试");
    await createDialog.getByRole("radio", { name: "发明" }).check();
    await createDialog.getByRole("button", { name: "创建专利" }).click();
    await openDrawingEntry(page, "插入流程图");

    await expect(page.getByRole("main", { name: "流程图编辑工作区" })).toBeVisible();
    await expect(page.getByRole("main", { name: "流程图工程列表" })).toHaveCount(0);
    await expect(
      (await currentDrawioFrame(page)).getByText("流程图兼容性测试-流程图1", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const flowchartTab = page.getByRole("tab", { name: "流程图", exact: true });
    await expect(flowchartTab).toBeVisible();
    await expect(flowchartTab).toHaveAttribute("aria-selected", "true");
    expect(
      await flowchartTab.evaluate(
        (tab) =>
          tab
            .closest(".menu-bar__flowchart-tab-group")
            ?.previousElementSibling?.classList.contains("patent-split-controls") ?? false,
      ),
    ).toBe(true);
    await expect(page.getByRole("toolbar", { name: "常用工具" })).toHaveCount(0);
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await expect(flowchartTab).toHaveCount(0);
    await expect(page.getByRole("main", { name: "专利编辑区" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("keeps drawing actions available across every patent book including toolbar overflow", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const createPatent = page.getByRole("dialog", { name: "新建专利" });
    await createPatent.getByRole("textbox", { name: "专利名称" }).fill("流程图全书册入口测试");
    await createPatent.getByRole("radio", { name: "发明" }).check();
    await createPatent.getByRole("button", { name: "创建专利" }).click();

    const books = ["权利要求书", "说明书", "说明书附图", "说明书摘要", "摘要附图"];
    for (const book of books) {
      await page.getByRole("tab", { name: book, exact: true }).click();
      const toolbar = page.getByRole("toolbar", { name: "常用工具" });
      const labels = ["插入流程图", "电路图"];
      let overflowOpen = false;
      for (const label of labels) {
        if (await toolbar.getByRole("button", { name: label, exact: true }).isVisible()) continue;
        if (!overflowOpen) {
          await toolbar.getByRole("button", { name: "更多工具" }).click();
          overflowOpen = true;
        }
        await expect(page.getByRole("menu").getByText(label, { exact: true })).toBeVisible();
      }
      if (overflowOpen) await page.keyboard.press("Escape");
    }

    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const claims = page.getByRole("textbox", { name: "编辑 权利要求书" });
    await claims.press("Control+End");
    await claims.type(" 保留的用户内容");
    await openDrawingEntry(page, "插入流程图");
    await expect(page.getByRole("main", { name: "流程图编辑工作区" })).toBeVisible();
    await renameCurrentFlowchart(page, "全书册入口流程图");
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(claims).toContainText("保留的用户内容");

    for (const book of ["说明书附图", "摘要附图"]) {
      await page.getByRole("tab", { name: book, exact: true }).click();
      await openDrawingEntry(page, "插入流程图");
      const editorWorkspace = page.getByRole("main", { name: "流程图编辑工作区" });
      await expect(editorWorkspace).toBeVisible();
      await page.getByRole("tab", { name: book, exact: true }).click();
      await expect(page.getByRole("tab", { name: "流程图", exact: true })).toHaveAttribute(
        "aria-selected",
        "false",
      );
    }

    await openDrawingEntry(page, "插入流程图");
    await renameCurrentFlowchart(page, "全书册入口流程图（已重命名）");
  } finally {
    await application.close().catch(() => undefined);
  }
  expect(await workbench.readObservedConnections()).toEqual([]);
});

test("exposes only approved Latin product and format names on operated draw.io surfaces", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  expect(isDrawioShortcutNotation("Ctrl+X")).toBe(true);
  expect(isDrawioShortcutNotation("F2/Enter")).toBe(true);
  expect(isDrawioShortcutNotation("UML")).toBe(false);
  expect(isDrawioShortcutNotation("ABC")).toBe(false);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const createPatent = page.getByRole("dialog", { name: "新建专利" });
    await createPatent.getByRole("textbox", { name: "专利名称" }).fill("流程图本地化巡检");
    await createPatent.getByRole("radio", { name: "发明" }).check();
    await createPatent.getByRole("button", { name: "创建专利" }).click();
    await openDrawingEntry(page, "插入流程图");
    await renameCurrentFlowchart(page, "本地化巡检流程图");
    const frame = await expect
      .poll(
        () => page.frames().find((candidate) => candidate.url().endsWith("/embed.html")) ?? null,
      )
      .not.toBeNull()
      .then(() => page.frames().find((candidate) => candidate.url().endsWith("/embed.html")));
    if (!frame) throw new Error("draw.io 编辑 frame 未加载");
    await expect(frame.locator("a.geItem").first()).toBeVisible();
    await expectVisibleDrawioUiLocalized(frame);
    const localizedTooltip = await frame.locator("body").evaluate((body) => {
      const tooltip = document.createElement("div");
      tooltip.className = "geSidebarTooltip";
      const title = document.createElement("div");
      title.textContent = "Rectangle";
      tooltip.appendChild(title);
      body.appendChild(tooltip);
      title.setAttribute("title", "Rectangle");
      const result = { text: title.textContent, title: title.title };
      tooltip.remove();
      return result;
    });
    expect(localizedTooltip).toEqual({ text: "矩形", title: "矩形" });
    const toolLabels = JSON.parse(
      await readFile(
        join(process.cwd(), "resources", "drawio", "localization", "tool-labels-zh.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    const tooltipMismatches = await frame.locator("body").evaluate((body, entries) => {
      const tooltip = document.createElement("div");
      tooltip.className = "geSidebarTooltip";
      const title = document.createElement("div");
      tooltip.appendChild(title);
      body.appendChild(tooltip);
      const mismatches: string[] = [];
      for (const [english, chinese] of entries) {
        title.textContent = english;
        title.setAttribute("title", english);
        if (title.textContent !== chinese || title.title !== chinese) {
          mismatches.push(`${english} => ${title.textContent} / ${title.title}`);
        }
      }
      tooltip.remove();
      return mismatches;
    }, Object.entries(toolLabels));
    expect(
      tooltipMismatches,
      `工具悬浮名称未应用中文词典：\n${tooltipMismatches.join("\n")}`,
    ).toEqual([]);
    const paletteTitles = frame.locator(
      ".geSidebarContainer:not(.geFormatContainer) .geTitle:visible",
    );
    const paletteCount = await paletteTitles.count();
    expect(paletteCount, "左侧至少应显示一个图形分类").toBeGreaterThan(0);
    for (let index = 0; index < paletteCount; index += 1) {
      const paletteTitle = paletteTitles.nth(index);
      await paletteTitle.scrollIntoViewIfNeeded();
      const paletteBody = paletteTitle.locator("xpath=following-sibling::div[1]");
      if ((await paletteBody.count()) > 0 && !(await paletteBody.isVisible())) {
        await paletteTitle.click();
      }
      await expectVisibleDrawioUiLocalized(frame);
    }

    await frame.getByRole("button", { name: "电路图", exact: true }).click();
    await expect(frame.getByText("电路 / 逻辑门", { exact: true }).first()).toBeVisible();
    await frame.getByRole("button", { name: "流程图", exact: true }).click();
    await expect(frame.locator(".geTitle:visible").filter({ hasText: /^杂项$/u })).toHaveCount(0);
    await expect(frame.locator(".geTitle:visible").filter({ hasText: /^高级$/u })).toHaveCount(0);
    const moreShapes = frame.getByRole("button", { name: "扩展图库" });
    const visiblePaletteCountBefore = await frame.locator(".geTitle:visible").count();
    await moreShapes.scrollIntoViewIfNeeded();
    await moreShapes.click();
    const moreShapesDialog = frame.locator(".geDialog:visible").last();
    await expect(moreShapesDialog).toBeVisible();
    await expectVisibleDrawioUiLocalized(frame);
    const disabledLibrary = moreShapesDialog
      .locator(".geMoreShapesItem")
      .filter({ hasText: /^杂项与高级$/u })
      .filter({ has: frame.locator('input[type="checkbox"]:not(:checked)') })
      .first();
    await expect(disabledLibrary, "扩展图库中应存在可启用的图库").toBeVisible();
    const enabledLibraryName = (await disabledLibrary.locator("span").innerText()).trim();
    expect(enabledLibraryName).toBe("杂项与高级");
    await expect(moreShapesDialog.getByText(/iOS Icons|iOS UI|iOS6/u)).toHaveCount(0);
    await expect(moreShapesDialog.getByText("杂项与高级", { exact: true })).toBeVisible();
    await disabledLibrary.locator('input[type="checkbox"]').check();
    await moreShapesDialog.getByRole("button", { name: "应用" }).click();
    await expect
      .poll(() => frame.locator(".geTitle:visible").count())
      .toBeGreaterThan(visiblePaletteCountBefore);
    await expectVisibleDrawioUiLocalized(frame);
    for (const panelName of ["查看", "流程图", "样式"]) {
      const panelTab = frame.getByText(panelName, { exact: true }).last();
      await expect(panelTab).toBeVisible();
      await panelTab.click();
      await expectVisibleDrawioUiLocalized(frame);
      if (panelName === "查看") {
        await expect(frame.getByText("阴影", { exact: true }).last()).toBeVisible();
      }
    }

    const menuBar = frame.locator(".geMenubarContainer");
    const editorFrameBox = await page.getByTitle("流程图编辑器").boundingBox();
    if (!editorFrameBox) throw new Error("流程图编辑器坐标不可用");
    const canvas = frame.locator(".geDiagramContainer");
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("流程图画布坐标不可用");
    const clickCanvas = async () => {
      await canvas.click({
        position: {
          x: Math.min(600, canvasBox.width - 20),
          y: Math.min(400, canvasBox.height - 20),
        },
      });
    };
    const menusWithSubmenus = new Set(["文件", "编辑", "查看", "排列", "其它"]);
    await expect(menuBar.getByText("帮助", { exact: true })).toHaveCount(0);
    for (const menuName of ["文件", "编辑", "查看", "排列", "其它"]) {
      const menu = menuBar.getByText(menuName, { exact: true });
      await expect(menu).toBeVisible();
      const menuBox = await menu.boundingBox();
      if (!menuBox) throw new Error(`${menuName}菜单坐标不可用`);
      await page.mouse.click(
        editorFrameBox.x + menuBox.x + menuBox.width / 2,
        editorFrameBox.y + menuBox.y + menuBox.height / 2,
      );
      const visiblePopups = frame.locator(".mxPopupMenu:visible");
      if ((await visiblePopups.count()) === 0) {
        await menu.evaluate((element) => {
          for (const type of ["mousedown", "mouseup", "click"]) {
            element.dispatchEvent(
              new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1 }),
            );
          }
        });
      }
      await expect(visiblePopups.last(), `${menuName}菜单未打开`).toBeVisible();
      await expectVisibleDrawioUiLocalized(frame);
      const primaryPopup = visiblePopups.last();
      const primaryText = await primaryPopup.innerText();
      const primaryLines = primaryText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (menuName === "文件") {
        expect(primaryLines.slice(0, 5)).toEqual([
          "新建流程图",
          "导入流程图",
          "重命名当前流程图",
          "复制当前流程图",
          "删除当前流程图",
        ]);
        expect(primaryText).toContain("导入自");
        expect(primaryText).toContain("导出为");
        expect(primaryText).toContain("页面设置");
        expect(primaryText).not.toContain("嵌入");
        expect(primaryText).not.toContain("打印");
      } else if (menuName === "编辑") {
        expect(primaryText).not.toMatch(
          /编辑数据|编辑提示|编辑样式|编辑几何图形|编辑多边形|编辑连接点|编辑链接|打开链接/u,
        );
      } else if (menuName === "查看") {
        expect(primaryText).toContain("网格");
        for (const removedItem of ["图层", "标签", "便笺本", "页面比例", "标尺", "动画"]) {
          expect(primaryLines).not.toContain(removedItem);
        }
      } else if (menuName === "其它") {
        expect(primaryText).toContain("高级功能");
        expect(primaryText).not.toMatch(/绘图语言|编辑绘图|插件/u);
        const advancedRow = primaryPopup.locator("tr").filter({ hasText: "高级功能" });
        await advancedRow.hover();
        const advancedPopup = frame.locator(".mxPopupMenu:visible").last();
        await expect(advancedPopup).toBeVisible();
        const advancedText = await advancedPopup.innerText();
        expect(advancedText).toMatch(/编辑数据/u);
        expect(advancedText).toMatch(/图层/u);
        expect(advancedText).toMatch(/标尺/u);
        expect(advancedText).toMatch(/页面比例/u);
        expect(advancedText).toMatch(/布局/u);
        expect(advancedText).toMatch(/折叠|展开/u);
      }
      let openedSubmenu = false;
      for (const row of await primaryPopup.locator("tr").all()) {
        if (!(await row.isVisible())) continue;
        await row.hover();
        if ((await visiblePopups.count()) > 1) {
          openedSubmenu = true;
          await expectVisibleDrawioUiLocalized(frame);
          break;
        }
      }
      if (menusWithSubmenus.has(menuName)) {
        expect(openedSubmenu, `${menuName}菜单应至少打开一个二级菜单`).toBe(true);
      }
      await clickCanvas();
      await expect(frame.locator(".mxPopupMenu:visible")).toHaveCount(0);
    }

    const fileMenu = menuBar.getByText("文件", { exact: true });
    const fileMenuBox = await fileMenu.boundingBox();
    if (!fileMenuBox) throw new Error("文件菜单坐标不可用");
    await page.mouse.click(
      editorFrameBox.x + fileMenuBox.x + fileMenuBox.width / 2,
      editorFrameBox.y + fileMenuBox.y + fileMenuBox.height / 2,
    );
    if ((await frame.locator(".mxPopupMenu:visible").count()) === 0) {
      await fileMenu.evaluate((element) => {
        for (const type of ["mousedown", "mouseup", "click"]) {
          element.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1 }),
          );
        }
      });
    }
    const filePopup = frame.locator(".mxPopupMenu:visible").last();
    await expect(filePopup).toBeVisible();
    await filePopup.locator("tr").filter({ hasText: "导出为" }).hover();
    const exportPopup = frame.locator(".mxPopupMenu:visible").last();
    await expect(exportPopup).toBeVisible();
    await exportPopup.locator("tr").filter({ hasText: /^PNG/u }).first().click();
    const exportDialog = frame.locator(".geDialog:visible").last();
    await expect(exportDialog).toBeVisible();
    await expect(exportDialog.getByText("网格", { exact: true })).toHaveCount(0);
    await expect(exportDialog.getByText("阴影", { exact: true })).toHaveCount(0);
    await exportDialog.getByRole("button", { name: "取消" }).click();

    await frame.getByRole("button", { name: "基础流程", exact: true }).click();
    await frame.getByText("处理步骤", { exact: true }).dblclick();
    const richTextEditor = frame.locator('.mxCellEditor[contenteditable="true"]:visible').last();
    await expect(richTextEditor).toBeVisible();
    await richTextEditor.pressSequentially("Shape Connector Helvetica");
    await richTextEditor.press("Control+Enter");
    await expect(frame.getByText("Shape Connector Helvetica", { exact: true })).toBeVisible();
    await canvas.click({ position: { x: 350, y: 260 } });
    await canvas.click({ button: "right", position: { x: 350, y: 260 } });
    await expect(frame.locator(".mxPopupMenu:visible").last()).toBeVisible();
    await expectVisibleDrawioUiLocalized(frame);
    await frame.locator("body").press("Escape");
    await frame.locator("body").press("Control+a");
    await clickCanvas();
    await frame.getByText("Shape Connector Helvetica", { exact: true }).click({ force: true });

    for (const panelName of ["样式", "文本", "排列"]) {
      const panelTab = frame.getByText(panelName, { exact: true }).last();
      await expect(panelTab).toBeVisible();
      await panelTab.click();
      await expectVisibleDrawioUiLocalized(frame);
    }
    for (const title of [
      "撤销 (Ctrl+Z)",
      "重做 (Ctrl+Y)",
      "放大 (Ctrl + / Alt+Mousewheel)",
      "缩小 (Ctrl - / Alt+Mousewheel)",
    ]) {
      const control = frame.getByTitle(title).first();
      await expect(control).toBeVisible();
      await control.hover();
      await expectVisibleDrawioUiLocalized(frame);
    }

    const pageTab = frame.locator(".geTabContainer .geTab:not(.geControlTab)").first();
    await expect(pageTab).toBeVisible();
    const pageMenuButton = pageTab.locator(".geButton");
    const pageTabBox = await pageMenuButton.boundingBox();
    if (!pageTabBox) throw new Error("流程图页签菜单坐标不可用");
    await pageMenuButton.click();
    const pagePopup = frame.locator(".mxPopupMenu:visible").last();
    if (!(await pagePopup.isVisible())) {
      await pageMenuButton.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        for (const [type, buttons] of [
          ["mousedown", 1],
          ["mouseup", 0],
          ["click", 0],
        ] as const) {
          button.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              buttons,
              clientX: bounds.left + bounds.width / 2,
              clientY: bounds.top + bounds.height / 2,
            }),
          );
        }
      });
    }
    await expect(
      pagePopup,
      `页签右键菜单未打开：${await pageTab.evaluate((tab) => tab.outerHTML)}`,
    ).toBeVisible();
    await expectVisibleDrawioUiLocalized(frame);
    await frame.getByText(/复制/u).last().click();
    await expect(frame.locator(".geTabContainer .gePageTab")).toHaveCount(2);
    const secondPageMenu = frame.locator(".geTabContainer .gePageTab").last().locator(".geButton");
    await secondPageMenu.click();
    await expect(frame.locator(".mxPopupMenu:visible").last()).toBeVisible();
    await expectVisibleDrawioUiLocalized(frame);
    await clickCanvas();
    const renamePage = async (tab: import("@playwright/test").Locator, name: string) => {
      await tab.dblclick();
      const dialog = frame.locator(".geDialog:visible").last();
      await expect(dialog).toBeVisible();
      const input = dialog.locator("input").first();
      await input.fill(name);
      await input.press("Enter");
    };
    const pageTabs = frame.locator(".geTabContainer .gePageTab");
    await renamePage(pageTabs.first(), "Shape");
    await expect(pageTabs.first().locator("span")).toHaveText("Shape");
    await expect(pageTabs.first()).toHaveAttribute("title", /^Shape \(/u);
    await renamePage(pageTabs.last(), "v1.0");
    await expect(pageTabs.last().locator("span")).toHaveText("v1.0");
    await expect(pageTabs.last()).toHaveAttribute("title", /^v1\.0 \(/u);
    await secondPageMenu.click();
    await expect(frame.locator(".mxPopupMenu:visible").last()).toBeVisible();
    await frame.getByText(/删除/u).last().click();
    await expect(frame.locator(".geTabContainer .gePageTab")).toHaveCount(1);
    // Autosave may already have disabled the clean-state save button.
    await frame.locator("body").press("Control+s");
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("creates, edits, saves and reopens a flowchart through visible user controls", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const createPatent = page.getByRole("dialog", { name: "新建专利" });
    await createPatent.getByRole("textbox", { name: "专利名称" }).fill("流程图用户操作测试");
    await createPatent.getByRole("radio", { name: "发明" }).check();
    await createPatent.getByRole("button", { name: "创建专利" }).click();
    await openDrawingEntry(page, "插入流程图");

    await expect(page.getByRole("main", { name: "流程图编辑工作区" })).toBeVisible();
    await renameCurrentFlowchart(page, "用户操作流程图");
    await chooseDrawioFileProjectAction(page, "新建流程图");
    const createdMenu = await openFlowchartProjectMenu(page);
    await expect(createdMenu.getByRole("menuitem")).toHaveCount(0);
    await expect(createdMenu.getByText("新建流程图", { exact: true })).toHaveCount(0);
    await expect(
      createdMenu
        .locator('[role="menuitemradio"][aria-checked="true"]')
        .filter({ hasText: "流程图用户操作测试-流程图1" }),
    ).toBeVisible();
    await createdMenu.getByRole("menuitemradio", { name: /用户操作流程图，/u }).click();
    await expect(createdMenu).not.toBeVisible();
    const switchedMenu = await openFlowchartProjectMenu(page);
    await expect(
      switchedMenu
        .locator('[role="menuitemradio"][aria-checked="true"]')
        .filter({ hasText: "用户操作流程图" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭流程图工程列表" }).click();
    const embedFrame = await currentDrawioFrame(page);
    const patentToolbar = embedFrame.locator(".geMenubarContainer.patent-toolbar");
    await expect(patentToolbar).toBeVisible();
    await expect(patentToolbar.getByText("第1页", { exact: true })).toBeVisible();
    expect(
      await patentToolbar.evaluate(
        (node) =>
          node.clientHeight <= 48 &&
          node.scrollHeight <= node.clientHeight &&
          [...node.children].every(
            (child) =>
              (child as HTMLElement).offsetTop + (child as HTMLElement).offsetHeight <=
              node.clientHeight,
          ),
      ),
    ).toBe(true);
    const textStencil = embedFrame.locator(".geSidebar a.geItem:visible").first();
    await expect(textStencil).toBeVisible();
    const outerBox = await page.getByTitle("流程图编辑器").boundingBox();
    const stencilBox = await textStencil.boundingBox();
    if (!outerBox || !stencilBox) throw new Error("流程图工具坐标不可用");
    expect(outerBox.height).toBeGreaterThan(500);
    const secondStencil = embedFrame.locator(".geSidebar a.geItem:visible").nth(1);
    const secondStencilBox = await secondStencil.boundingBox();
    if (!secondStencilBox) throw new Error("第二个流程图工具坐标不可用");
    await secondStencil.dragTo(embedFrame.locator(".geDiagramContainer"), {
      targetPosition: { x: 360, y: 240 },
    });
    await textStencil.dragTo(embedFrame.locator(".geDiagramContainer"), {
      targetPosition: { x: 520, y: 360 },
    });

    await expect(embedFrame.getByText("未保存", { exact: true })).toBeVisible();
    await embedFrame.locator("body").press("Control+s");
    await expect(embedFrame.getByText("已保存", { exact: true })).toBeVisible();
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 900, height: 760 });
    await expect(patentToolbar).toBeVisible();
    expect(
      await patentToolbar.evaluate(
        (node) =>
          node.scrollHeight <= node.clientHeight && getComputedStyle(node).flexWrap === "nowrap",
      ),
    ).toBe(true);
    if (originalViewport) await page.setViewportSize(originalViewport);
    await page.evaluate(() => {
      const state = window as typeof window & {
        capturedFlowchartExports?: string[];
        capturedFlowchartExportHeaders?: string[];
      };
      state.capturedFlowchartExports = [];
      state.capturedFlowchartExportHeaders = [];
      const createObjectURL = URL.createObjectURL;
      URL.createObjectURL = function captureFlowchartBlob(blob) {
        if (blob instanceof Blob && blob.type === "application/xml") {
          void blob.text().then((text) => state.capturedFlowchartExports?.push(text));
        }
        if (blob instanceof Blob && blob.type === "application/pdf") {
          void blob.arrayBuffer().then((buffer) => {
            const header = new TextDecoder().decode(new Uint8Array(buffer).slice(0, 8));
            state.capturedFlowchartExportHeaders?.push(`${blob.type}:${header}`);
          });
        }
        return createObjectURL.call(URL, blob);
      };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function captureFlowchartExport() {
        const separator = this.href.indexOf(",");
        if (this.href.startsWith("data:") && separator >= 0) {
          const metadata = this.href.slice(0, separator);
          const body = this.href.slice(separator + 1);
          const text = metadata.includes(";base64")
            ? new TextDecoder().decode(
                Uint8Array.from(atob(body), (character) => character.charCodeAt(0)),
              )
            : decodeURIComponent(body);
          state.capturedFlowchartExports?.push(text);
          if (metadata.startsWith("data:image/jpeg") && metadata.includes(";base64")) {
            const bytes = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
            state.capturedFlowchartExportHeaders?.push(
              `${metadata.slice(5, metadata.indexOf(";"))}:${Array.from(bytes.slice(0, 3), (value) => value.toString(16).padStart(2, "0")).join("")}`,
            );
          }
        }
        return click.call(this);
      };
    });
    await clickDrawioToolbarAction(page, "导出至电脑");
    const selectionDialog = page.getByRole("dialog", { name: "导出至电脑" });
    await expect(selectionDialog.getByAltText("导出内容预览")).toBeVisible();
    await selectionDialog.getByRole("button", { name: "放大预览" }).click();
    await expect(selectionDialog.getByLabel("预览缩放比例")).toHaveText("125%");
    const previewViewport = selectionDialog.getByTestId("flowchart-image-preview-viewport");
    const previewViewportBox = await previewViewport.boundingBox();
    if (!previewViewportBox) throw new Error("导出预览区域不可测量");
    await page.mouse.move(previewViewportBox.x + 40, previewViewportBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(previewViewportBox.x + 75, previewViewportBox.y + 65);
    await page.mouse.up();
    await expect(selectionDialog.getByAltText("导出内容预览")).toHaveAttribute(
      "style",
      /translate\(35px, 25px\)/u,
    );
    await selectionDialog.getByRole("button", { name: "重置预览" }).click();
    const fittedPercent = Number.parseFloat(
      await selectionDialog.getByLabel("预览缩放比例").innerText(),
    );
    expect(fittedPercent).toBeGreaterThan(0);
    expect(fittedPercent).toBeLessThanOrEqual(100);
    const fittedImageBox = await selectionDialog.getByAltText("导出内容预览").boundingBox();
    const fittedViewportBox = await previewViewport.boundingBox();
    if (!fittedImageBox || !fittedViewportBox) throw new Error("导出预览适应状态不可测量");
    expect(fittedImageBox.width).toBeLessThanOrEqual(fittedViewportBox.width + 1);
    expect(fittedImageBox.height).toBeLessThanOrEqual(fittedViewportBox.height + 1);
    await selectionDialog.getByLabel("导出格式").selectOption("drawio");
    await selectionDialog.getByRole("radio", { name: "当前选取" }).check();
    await selectionDialog.getByRole("button", { name: "确认导出" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              (
                window as typeof window & { capturedFlowchartExports?: string[] }
              ).capturedFlowchartExports?.[0]?.match(/vertex="1"/gu) ?? []
            ).length,
        ),
      )
      .toBe(1);
    const selectionSource = await page.evaluate(
      () =>
        (window as typeof window & { capturedFlowchartExports?: string[] })
          .capturedFlowchartExports?.[0] ?? "",
    );
    expect(selectionSource).toContain("<mxGraphModel");
    await clickDrawioToolbarAction(page, "导出至电脑");
    const exportDialog = page.getByRole("dialog", { name: "导出至电脑" });
    await exportDialog.getByLabel("导出格式").selectOption("drawio");
    await exportDialog.getByRole("button", { name: "确认导出" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & { capturedFlowchartExports?: string[] }
            ).capturedFlowchartExports
              ?.at(-1)
              ?.match(/vertex="1"/gu)?.length ?? 0,
        ),
      )
      .toBe(2);
    const firstSource = await page.evaluate(
      () =>
        (
          window as typeof window & { capturedFlowchartExports?: string[] }
        ).capturedFlowchartExports?.at(-1) ?? "",
    );
    await expect(exportDialog).not.toBeVisible();
    await clickDrawioToolbarAction(page, "导出至电脑");
    await page
      .getByRole("dialog", { name: "导出至电脑" })
      .getByLabel("导出格式")
      .selectOption("jpeg");
    await page
      .getByRole("dialog", { name: "导出至电脑" })
      .getByRole("button", { name: "确认导出" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { capturedFlowchartExportHeaders?: string[] })
              .capturedFlowchartExportHeaders ?? [],
        ),
      )
      .toContain("image/jpeg:ffd8ff");
    await clickDrawioToolbarAction(page, "导出至电脑");
    await page
      .getByRole("dialog", { name: "导出至电脑" })
      .getByLabel("导出格式")
      .selectOption("pdf");
    await page
      .getByRole("dialog", { name: "导出至电脑" })
      .getByRole("button", { name: "确认导出" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { capturedFlowchartExportHeaders?: string[] })
              .capturedFlowchartExportHeaders ?? [],
        ),
      )
      .toEqual(expect.arrayContaining([expect.stringMatching(/^application\/pdf:%PDF-/)]));
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await openDrawingEntry(page, "插入流程图");
    const reopenedEmbedFrame = await currentDrawioFrame(page);
    await expect(reopenedEmbedFrame.getByText("用户操作流程图", { exact: true })).toBeVisible();
    await expect(reopenedEmbedFrame.locator(".patent-toolbar__page")).toHaveText("第1页");
    await clickDrawioToolbarAction(page, "导出至电脑");
    const reopenedExportDialog = page.getByRole("dialog", { name: "导出至电脑" });
    await reopenedExportDialog.getByLabel("导出格式").selectOption("drawio");
    await reopenedExportDialog.getByRole("button", { name: "确认导出" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & { capturedFlowchartExports?: string[] }
            ).capturedFlowchartExports
              ?.at(-1)
              ?.replace(/dx="\d+" dy="\d+"/, "") ?? "",
        ),
      )
      .toBe(firstSource.replace(/dx="\d+" dy="\d+"/, ""));
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await expect(page.getByRole("tab", { name: "流程图", exact: true })).toHaveCount(0);
    await expect(page.getByRole("main", { name: "专利编辑区" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
  expect(await workbench.readObservedConnections()).toEqual([]);
});

test("creates persistent constrained wires only in circuit mode", async ({ workbench }) => {
  test.setTimeout(300_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await page.evaluate(() => {
      const state = window as typeof window & { capturedCircuitSources?: string[] };
      state.capturedCircuitSources = [];
      const createObjectURL = URL.createObjectURL;
      URL.createObjectURL = function captureCircuitSource(blob) {
        if (blob instanceof Blob && blob.type === "application/xml") {
          void blob.text().then((text) => state.capturedCircuitSources?.push(text));
        }
        return createObjectURL.call(URL, blob);
      };
    });
    const exportSource = async () => {
      const before = await page.evaluate(
        () =>
          (window as typeof window & { capturedCircuitSources?: string[] }).capturedCircuitSources
            ?.length ?? 0,
      );
      await clickDrawioToolbarAction(page, "导出至电脑");
      const dialog = page.getByRole("dialog", { name: "导出至电脑" });
      await dialog.getByLabel("导出格式").selectOption("drawio");
      await dialog.getByRole("button", { name: "确认导出" }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { capturedCircuitSources?: string[] })
                .capturedCircuitSources?.length ?? 0,
          ),
        )
        .toBe(before + 1);
      return page.evaluate(
        () =>
          (
            window as typeof window & { capturedCircuitSources?: string[] }
          ).capturedCircuitSources?.at(-1) ?? "",
      );
    };
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const createPatent = page.getByRole("dialog", { name: "新建专利" });
    await createPatent.getByRole("textbox", { name: "专利名称" }).fill("快捷连线测试");
    await createPatent.getByRole("radio", { name: "发明" }).check();
    await createPatent.getByRole("button", { name: "创建专利" }).click();

    await openDrawingEntry(page, "电路图");
    let frame = await currentDrawioFrame(page);
    const toolbar = frame.getByRole("toolbar", { name: "流程图工具栏" });
    const quickWiring = frame.getByRole("button", { name: "快捷连线", exact: true });
    const circuitStatus = frame.locator(".patent-toolbar__circuit-status");
    await expect(quickWiring).toBeVisible();
    expect(
      await quickWiring.evaluate((button) => ({
        height: getComputedStyle(button).height,
        fontWeight: getComputedStyle(button).fontWeight,
      })),
    ).toEqual({ height: "24px", fontWeight: "700" });
    await expect(toolbar.getByRole("button", { name: "电路图", exact: true })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(
      await quickWiring.evaluate((button) => {
        const group = button.closest(".patent-toolbar__circuit-tools");
        const divider = group?.previousElementSibling;
        const freehand = divider?.previousElementSibling;
        return {
          lowerToolbar: Boolean(group?.closest(".geToolbarContainer")),
          divider: divider?.classList.contains("patent-toolbar__circuit-divider") ?? false,
          freehand: freehand?.getAttribute("title") ?? freehand?.getAttribute("aria-label") ?? "",
        };
      }),
    ).toEqual({ lowerToolbar: true, divider: true, freehand: expect.stringMatching(/^自由绘图/u) });

    const circuitPalette = frame.locator("a.geTitle").filter({ hasText: "电路 / 逻辑门" }).first();
    await expect(circuitPalette).toBeVisible();
    await circuitPalette.click();
    const circuitStencils = circuitPalette.locator(
      "xpath=following-sibling::div[1]//a[contains(@class, 'geItem')]",
    );
    await expect(circuitStencils.first()).toBeVisible();
    const canvas = frame.locator(".geDiagramContainer");
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("流程图画布坐标不可用");
    const dragStencil = async (
      stencil: import("@playwright/test").Locator,
      x: number,
      y: number,
    ) => {
      const stencilBox = await stencil.boundingBox();
      if (!stencilBox) throw new Error("电路图库坐标不可用");
      await page.mouse.move(
        stencilBox.x + stencilBox.width / 2,
        stencilBox.y + stencilBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(canvasBox.x + x, canvasBox.y + y, { steps: 20 });
      await page.mouse.up();
    };
    await dragStencil(circuitStencils.first(), 360, 260);
    const resistorPalette = frame.locator("a.geTitle").filter({ hasText: "电路 / 电阻器" }).first();
    await expect(resistorPalette).toBeVisible();
    await resistorPalette.click();
    const resistorStencil = resistorPalette
      .locator("xpath=following-sibling::div[1]//a[contains(@class, 'geItem')]")
      .first();
    await expect(resistorStencil).toBeVisible();
    await dragStencil(resistorStencil, 620, 260);
    await expect(frame.getByText("未保存", { exact: true })).toBeVisible();

    await quickWiring.click();
    await expect(quickWiring).toHaveAttribute("aria-pressed", "true");
    const initialModel = readCircuitModel(await exportSource());
    const [firstCircuit, secondCircuit] = initialModel.vertices;
    if (!firstCircuit || !secondCircuit) throw new Error("未找到两个电气元件");
    expect(firstCircuit.style).toContain("patentCircuitScale=60");
    expect(secondCircuit.style).toContain("patentCircuitScale=60");
    expect({ width: firstCircuit.width, height: firstCircuit.height }).toEqual({
      width: 60,
      height: 36,
    });
    expect({ width: secondCircuit.width, height: secondCircuit.height }).toEqual({
      width: 60,
      height: 12,
    });
    const terminals = frame.getByRole("button", { name: /^连接端子 /u });
    await expect(terminals.first()).toBeVisible();
    const firstCircuitPorts = frame.getByRole("button", {
      name: new RegExp(`^连接端子 ${firstCircuit.id} `, "u"),
    });
    const secondCircuitPorts = frame.getByRole("button", {
      name: new RegExp(`^连接端子 ${secondCircuit.id} `, "u"),
    });
    const nativePortLabels = await firstCircuitPorts.evaluateAll((ports) =>
      ports.map((port) => port.getAttribute("aria-label") ?? ""),
    );
    expect(nativePortLabels).toHaveLength(3);
    expect(nativePortLabels.every((label) => !/(?: left| top| right| bottom)$/u.test(label))).toBe(
      true,
    );
    await firstCircuitPorts.first().click();
    await secondCircuitPorts.first().click();
    await expect(quickWiring).toHaveAttribute("aria-pressed", "true");
    await expect(circuitStatus).toHaveText("请选择起始连接端子");

    await toolbar.getByRole("button", { name: "流程图", exact: true }).click();
    await expect(quickWiring).toBeHidden();
    const generalPalette = frame.locator("a.geTitle:visible").first();
    const generalStencils = generalPalette.locator(
      "xpath=following-sibling::div[1]//a[contains(@class, 'geItem')]",
    );
    if ((await generalStencils.count()) === 0) await generalPalette.click();
    await expect(generalStencils.first()).toBeVisible();
    await dragStencil(generalStencils.first(), 500, 480);

    await toolbar.getByRole("button", { name: "电路图", exact: true }).click();
    await expect(quickWiring).toBeVisible();
    await quickWiring.click();
    const threeVertexModel = readCircuitModel(await exportSource());
    const generalVertex = threeVertexModel.vertices.find(
      (vertex) => !vertex.style.includes("shape=mxgraph.electrical."),
    );
    if (!generalVertex) throw new Error("未找到普通图形");
    const refreshedFirstPorts = frame.getByRole("button", {
      name: new RegExp(`^连接端子 ${firstCircuit.id} `, "u"),
    });
    const generalPorts = frame.getByRole("button", {
      name: new RegExp(`^连接端子 ${generalVertex.id} `, "u"),
    });
    await expect(generalPorts).toHaveCount(4);
    await refreshedFirstPorts.first().click();
    await generalPorts.first().click();

    await refreshedFirstPorts.first().click();
    await canvas.click({ position: { x: 50, y: 50 } });
    await expect(terminals.first()).toBeVisible();
    await expect(quickWiring).toHaveAttribute("aria-pressed", "true");

    await refreshedFirstPorts.first().click();
    await frame.locator("body").press("Escape");
    await expect(terminals.first()).toBeVisible();
    await expect(quickWiring).toHaveAttribute("aria-pressed", "true");
    await frame.locator("body").press("Escape");
    await expect(quickWiring).toHaveAttribute("aria-pressed", "false");
    await expect(terminals).toHaveCount(0);
    await expect(circuitStatus).toHaveText("");

    const beforeMoveSource = await exportSource();
    const beforeMoveModel = readCircuitModel(beforeMoveSource);
    const movedVertexBefore = beforeMoveModel.vertices.find((vertex) =>
      vertex.style.includes("shape=mxgraph.electrical."),
    );
    if (!movedVertexBefore) throw new Error("未找到待移动的电气元件");
    const connectedEdgesBefore = beforeMoveModel.edges.filter(
      (edge) => edge.source === movedVertexBefore.id || edge.target === movedVertexBefore.id,
    );
    expect(connectedEdgesBefore.length).toBeGreaterThan(0);
    const edgePathsBefore = await frame
      .locator('.geDiagramContainer svg path[fill="none"]')
      .evaluateAll((paths) => paths.map((path) => path.getAttribute("d") ?? "").sort());
    const movedShapeBox = await frame
      .locator('.geDiagramContainer svg g[style*="visibility: visible"]')
      .first()
      .boundingBox();
    if (!movedShapeBox) throw new Error("待移动电气元件的可见边界不可用");
    await page.mouse.move(
      movedShapeBox.x + movedShapeBox.width / 2,
      movedShapeBox.y + movedShapeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      movedShapeBox.x + movedShapeBox.width / 2 + 60,
      movedShapeBox.y + movedShapeBox.height / 2 + 80,
      { steps: 20 },
    );
    await page.mouse.up();
    const afterMoveSource = await exportSource();
    const afterMoveModel = readCircuitModel(afterMoveSource);
    const movedVertexAfter = afterMoveModel.vertices.find(
      (vertex) => vertex.id === movedVertexBefore.id,
    );
    expect(movedVertexAfter).toBeDefined();
    expect({ x: movedVertexAfter?.x, y: movedVertexAfter?.y }).not.toEqual({
      x: movedVertexBefore.x,
      y: movedVertexBefore.y,
    });
    expect(
      afterMoveModel.edges.filter(
        (edge) => edge.source === movedVertexBefore.id || edge.target === movedVertexBefore.id,
      ),
    ).toEqual(connectedEdgesBefore);
    const edgePathsAfter = await frame
      .locator('.geDiagramContainer svg path[fill="none"]')
      .evaluateAll((paths) => paths.map((path) => path.getAttribute("d") ?? "").sort());
    expect(edgePathsAfter).not.toEqual(edgePathsBefore);
    await quickWiring.click();
    await generalPorts.first().click();
    await secondCircuitPorts.first().click();
    await quickWiring.click();
    await expect(quickWiring).toHaveAttribute("aria-pressed", "false");
    await expect(terminals).toHaveCount(0);
    await expect(circuitStatus).toHaveText("");

    const edgeCount = (source: string) => source.match(/edge="1"/gu)?.length ?? 0;
    await toolbar.getByRole("button", { name: "撤销", exact: true }).click();
    const undoneSource = await exportSource();
    expect(edgeCount(undoneSource)).toBe(2);
    await toolbar.getByRole("button", { name: "重做", exact: true }).click();
    const redoneSource = await exportSource();
    expect(edgeCount(redoneSource)).toBe(3);

    await expect(frame.getByRole("button", { name: "整理连线", exact: true })).toHaveCount(0);
    await expect(frame.getByRole("checkbox", { name: "同时整理元器件" })).toHaveCount(0);

    const save = frame.getByRole("button", { name: "保存", exact: true });
    if (await save.isEnabled()) await save.click();
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
    const savedSource = await exportSource();
    const savedModel = readCircuitModel(savedSource);
    expect(savedModel.vertices).toHaveLength(3);
    expect(savedModel.edges).toHaveLength(3);
    for (const edge of savedModel.edges) {
      expect(edge.id).not.toBe("");
      expect(edge.source).not.toBe("");
      expect(edge.target).not.toBe("");
      expect(edge.style).toContain("startArrow=none");
      expect(edge.style).toContain("endArrow=none");
      expect(edge.constraints).toHaveLength(4);
    }
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await openDrawingEntry(page, "电路图");
    frame = await currentDrawioFrame(page);
    const reopenedSource = await exportSource();
    const reopenedModel = readCircuitModel(reopenedSource);
    expect(reopenedModel.vertices).toHaveLength(3);
    expect(reopenedModel.edges).toEqual(savedModel.edges);
    const reopenedToolbar = frame.getByRole("toolbar", { name: "流程图工具栏" });
    await reopenedToolbar.getByRole("button", { name: "流程图", exact: true }).click();
    await expect(frame.getByRole("button", { name: "快捷连线" })).toBeHidden();
    const flowchartSource = await exportSource();
    expect(flowchartSource.match(/vertex="1"/gu)).toHaveLength(3);
    expect(flowchartSource.match(/edge="1"/gu)).toHaveLength(3);
  } finally {
    await application.close().catch(() => undefined);
  }
  expect(await workbench.readObservedConnections()).toEqual([]);
});

test("exports, replaces and detaches a linked description drawing", async ({ workbench }) => {
  test.setTimeout(180_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
    await expect(welcome).toBeVisible();
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();

    await page.getByRole("button", { name: "新建专利" }).click();
    const createPatent = page.getByRole("dialog", { name: "新建专利" });
    await createPatent.getByRole("textbox", { name: "专利名称" }).fill("流程图附图关联测试");
    await createPatent.getByRole("radio", { name: "发明" }).check();
    await createPatent.getByRole("button", { name: "创建专利" }).click();
    await openDrawingEntry(page, "插入流程图");
    await renameCurrentFlowchart(page, "附图关联流程图");

    const addRichTextHeading = async () => {
      const embedFrame = await currentDrawioFrame(page);
      const headingStencil = embedFrame.locator(".geSidebar a.geItem:visible").first();
      await expect(headingStencil).toBeVisible();
      await expect(embedFrame.getByText("已保存", { exact: true })).toBeVisible();
      await headingStencil.click();
      await expect(embedFrame.getByRole("button", { name: "黑白线稿", exact: true })).toBeEnabled();
      return embedFrame;
    };

    let embedFrame = await addRichTextHeading();
    await embedFrame.locator("body").press("Control+a");
    await embedFrame.locator("body").press("F2");
    const richTextEditor = embedFrame
      .locator('.mxCellEditor[contenteditable="true"]:visible')
      .last();
    await expect(richTextEditor).toBeVisible();
    await richTextEditor.press("Control+a");
    await richTextEditor.pressSequentially("带文字的流程图形");
    await richTextEditor.press("Control+Enter");
    await expect(
      embedFrame.locator(".geDiagramContainer").getByText("带文字的流程图形", { exact: true }),
    ).toBeVisible();
    await expect(embedFrame.getByText("未保存", { exact: true })).toBeVisible();

    await clickDrawioToolbarAction(page, "导出至电脑");
    const externalDialog = page.getByRole("dialog", { name: "导出至电脑" });
    const externalPreview = externalDialog.getByAltText("导出内容预览");
    await expect(externalPreview).toBeVisible();
    const exportedSvg = await externalPreview.evaluate((image) => {
      const source = (image as HTMLImageElement).src;
      const separator = source.indexOf(",");
      if (separator < 0) return "";
      const metadata = source.slice(0, separator);
      const body = source.slice(separator + 1);
      return metadata.includes(";base64")
        ? new TextDecoder().decode(
            Uint8Array.from(atob(body), (character) => character.charCodeAt(0)),
          )
        : decodeURIComponent(body);
    });
    expect(exportedSvg).not.toContain("<foreignObject");
    expect(exportedSvg).toContain("带文字的流程图形");
    const externalDialogBox = await externalDialog.boundingBox();
    if (!externalDialogBox) throw new Error("导出至电脑弹窗不可测量");
    await externalDialog.getByRole("button", { name: "取消" }).click();

    await clickDrawioToolbarAction(page, "插入附图");
    const addDialog = page.getByRole("dialog", { name: "插入到说明书附图" });
    const patentDialogBox = await addDialog.boundingBox();
    if (!patentDialogBox) throw new Error("导出至说明书附图弹窗不可测量");
    expect(Math.abs(patentDialogBox.width - externalDialogBox.width)).toBeLessThanOrEqual(1);
    const previewImage = addDialog.getByAltText("最终黑白专利附图预览");
    await expect(previewImage).toBeVisible();
    const initialWidth = await previewImage.evaluate((image) => parseFloat(image.style.width));
    await addDialog.getByRole("button", { name: "重置预览" }).click();
    const patentPreviewViewport = addDialog.getByTestId("flowchart-image-preview-viewport");
    const fittedPatentImageBox = await previewImage.boundingBox();
    const patentPreviewViewportBox = await patentPreviewViewport.boundingBox();
    if (!fittedPatentImageBox || !patentPreviewViewportBox) {
      throw new Error("说明书附图预览适应状态不可测量");
    }
    expect(fittedPatentImageBox.width).toBeLessThanOrEqual(patentPreviewViewportBox.width + 1);
    expect(fittedPatentImageBox.height).toBeLessThanOrEqual(patentPreviewViewportBox.height + 1);
    await previewImage.evaluate((image) => {
      image.style.height = "2000px";
      image.style.maxHeight = "none";
    });
    const dialogBox = await addDialog.boundingBox();
    const actionBox = await addDialog.locator(".standard-dialog__footer").boundingBox();
    if (!dialogBox || !actionBox) throw new Error("流程图附图导出弹窗布局不可测量");
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1);
    await addDialog.getByRole("button", { name: "添加为图 1" }).click();
    await expect(addDialog).not.toBeVisible();

    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    const figure = page.getByRole("article", { name: "图1" });
    await expect(figure).toBeVisible();
    await expect(figure.getByText("流程图来源")).toBeVisible();
    await expect(figure.getByAltText("图1")).toBeVisible();
    await expect(figure.locator(".drawing-figure-frame")).toHaveAttribute(
      "style",
      new RegExp(`width: ${initialWidth}mm`, "u"),
    );
    await expect(figure.locator(".drawing-figure-frame")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );

    const selectFigure = figure.getByRole("button", { name: "选择图1" });
    await selectFigure.click();
    await expect(selectFigure).toHaveAttribute("aria-pressed", "true");
    const bottomRightResize = figure.getByRole("button", { name: "从右下角缩放图1" });
    const bottomRightResizeBox = await bottomRightResize.boundingBox();
    if (!bottomRightResizeBox) throw new Error("说明书附图缩放手柄不可测量");
    await page.mouse.move(
      bottomRightResizeBox.x + bottomRightResizeBox.width / 2,
      bottomRightResizeBox.y + bottomRightResizeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(bottomRightResizeBox.x + 1_000, bottomRightResizeBox.y + 100);
    await page.mouse.up();
    await expect(figure.locator(".drawing-figure-frame")).toHaveAttribute("style", /width: 165mm/u);
    const wideFigureBox = await figure.locator(".drawing-figure-frame").boundingBox();
    const figureViewportBox = await page.getByTestId("drawing-pairs-scroll").boundingBox();
    if (!wideFigureBox || !figureViewportBox) throw new Error("超宽说明书附图布局不可测量");
    expect(wideFigureBox.x).toBeGreaterThanOrEqual(figureViewportBox.x - 1);
    expect(wideFigureBox.x + wideFigureBox.width).toBeLessThanOrEqual(
      figureViewportBox.x + figureViewportBox.width + 1,
    );
    await page.keyboard.press("Escape");
    await expect(selectFigure).toHaveAttribute("aria-pressed", "false");

    await selectFigure.click();
    await expect(selectFigure).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("main", { name: "说明书附图页面" })
      .locator(".patent-book-page-header")
      .click();
    await expect(selectFigure).toHaveAttribute("aria-pressed", "false");

    await figure.dblclick();
    await expect(page.getByRole("main", { name: "流程图编辑工作区" })).toBeVisible();
    await expect(
      (await currentDrawioFrame(page)).getByText("附图关联流程图", { exact: true }),
    ).toBeVisible();
    embedFrame = await addRichTextHeading();
    await embedFrame.locator("body").press("Control+s");
    await expect(embedFrame.getByText("已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();

    const staleFigure = page.getByRole("article", { name: "图1" });
    await expect(staleFigure.getByText("源工程已修改，附图尚未重新导出。")).toBeVisible();
    await staleFigure.dblclick();
    await expect(page.getByRole("main", { name: "流程图编辑工作区" })).toBeVisible();
    embedFrame = await addRichTextHeading();
    await embedFrame.locator("body").press("Control+s");
    await expect(embedFrame.getByText("已保存", { exact: true })).toBeVisible();
    await clickDrawioToolbarAction(page, "导出至电脑");
    await expect(externalDialog.getByAltText("导出内容预览")).toBeVisible();
    const replacementSvg = await externalDialog.getByAltText("导出内容预览").evaluate((image) => {
      const source = (image as HTMLImageElement).src;
      const separator = source.indexOf(",");
      const body = source.slice(separator + 1);
      return source.slice(0, separator).includes(";base64")
        ? new TextDecoder().decode(
            Uint8Array.from(atob(body), (character) => character.charCodeAt(0)),
          )
        : decodeURIComponent(body);
    });
    expect(replacementSvg).toContain("带文字的流程图形");
    await externalDialog.getByRole("button", { name: "取消" }).click();
    await clickDrawioToolbarAction(page, "替换附图");
    const replaceDialog = page.getByRole("dialog", { name: "替换说明书附图" });
    await expect(replaceDialog.getByAltText("现有图1")).toBeVisible();
    await expect(replaceDialog.getByAltText("流程图成图预览")).toBeVisible();
    const replacementSize = await replaceDialog
      .getByAltText("流程图成图预览")
      .evaluate((image: HTMLImageElement) => ({
        widthPx: image.naturalWidth,
        heightPx: image.naturalHeight,
      }));
    const replacementWidth = Math.min(
      165,
      insertedFigureWidthMm(DEFAULT_PAGE_SETTINGS, replacementSize),
    );
    await replaceDialog.getByRole("button", { name: "替换图1" }).click();
    await expect(replaceDialog).not.toBeVisible();
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();

    await expect(page.getByRole("article", { name: "图1" })).toHaveCount(1);
    const replacedFigure = page.getByRole("article", { name: "图1" });
    await expect(replacedFigure.getByText("流程图来源")).toBeVisible();
    const replacedFigureStyle =
      (await replacedFigure.locator(".drawing-figure-frame").getAttribute("style")) ?? "";
    const replacedWidthMm = Number(/width:\s*([\d.]+)mm/u.exec(replacedFigureStyle)?.[1]);
    expect(replacedWidthMm).toBe(replacementWidth);
    await expect(page.getByText("源工程已修改，附图尚未重新导出。")).toHaveCount(0);

    await page.getByRole("article", { name: "图1" }).dblclick();
    await chooseDrawioFileProjectAction(page, "删除当前流程图");
    const deleteDialog = page.getByRole("alertdialog", { name: "删除流程图工程" });
    await deleteDialog.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByRole("main", { name: "流程图编辑工作区" })).toBeVisible();
    const replacementMenu = await openFlowchartProjectMenu(page);
    await expect(
      replacementMenu
        .locator('[role="menuitemradio"][aria-checked="true"]')
        .filter({ hasText: "流程图附图关联测试-流程图1" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭流程图工程列表" }).click();
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    const detachedFigure = page.getByRole("article", { name: "图1" });
    await expect(detachedFigure).toBeVisible();
    await expect(detachedFigure.getByAltText("图1")).toBeVisible();
    await expect(detachedFigure.getByText("流程图来源")).toHaveCount(0);
  } finally {
    await application.close().catch(() => undefined);
  }
  expect(await workbench.readObservedConnections()).toEqual([]);
});

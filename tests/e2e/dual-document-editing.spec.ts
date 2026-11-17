import type { Locator, Page } from "@playwright/test";
import {
  choosePaneBook,
  enterDualView,
  expect,
  expectActivePane,
  selectDualPane,
  swapDualPanes,
  test,
} from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

async function createPatent(page: Page, name: string): Promise<void> {
  const libraryTab = page.getByRole("tab", { name: "专利库" });
  if (await libraryTab.isVisible()) await libraryTab.click();
  await page.getByRole("button", { name: "新建专利" }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "实用新型" }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function replaceEditorText(editor: Locator, text: string) {
  await editor.click();
  await editor.press("Control+A");
  await editor.pressSequentially(text);
}

async function reopenPatent(page: Page, name: string): Promise<void> {
  const card = page.getByRole("article", { name });
  await card.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function expectRenderedWidth(
  locator: Locator,
  expectedWidth: number,
  tolerance = 1,
): Promise<void> {
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box ? Math.abs(box.width - expectedWidth) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(tolerance);
}

async function expectMatchingWidths(first: Locator, second: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
      return firstBox && secondBox
        ? Math.abs(firstBox.width - secondBox.width)
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(1);
}

async function expectMatchingRightEdges(element: Locator, pane: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [elementBox, paneBox] = await Promise.all([element.boundingBox(), pane.boundingBox()]);
      return elementBox && paneBox
        ? Math.abs(elementBox.x + elementBox.width - (paneBox.x + paneBox.width))
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(2);
}

async function expectRightInset(
  element: Locator,
  pane: Locator,
  expectedInset: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const [elementBox, paneBox] = await Promise.all([element.boundingBox(), pane.boundingBox()]);
      return elementBox && paneBox
        ? Math.abs(paneBox.x + paneBox.width - (elementBox.x + elementBox.width) - expectedInset)
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(2);
}

async function movePointerTo(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("无法定位功能栏悬停目标");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function movePointerAwayFromRail(page: Page, pane: Locator): Promise<void> {
  const box = await pane.boundingBox();
  if (!box) throw new Error("无法定位文档窗格");
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
}

async function zoomActivePaneUntilRailCollapses(page: Page, pane: Locator): Promise<Locator> {
  const expandButton = pane.getByRole("button", { name: "展开功能栏" });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await expandButton.isVisible()) return expandButton;
    await page.getByRole("button", { name: "放大" }).click();
  }
  await expect(expandButton).toBeVisible();
  return expandButton;
}

async function zoomActivePaneUntilRailDocks(
  page: Page,
  rail: Locator,
  pane: Locator,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await rail.isVisible()) return;
    await pane.getByRole("textbox").click();
    await page.getByRole("button", { name: "缩小" }).click();
  }
  await expect(rail).toBeVisible();
}

test("edits, swaps, zooms and persists two books from one patent", async ({ workbench }) => {
  test.setTimeout(120_000);
  const patentName = "同屏双显数据安全夹具";
  let application = await workbench.launch();
  try {
    let page = await application.firstWindow();
    // Hidden Electron may suspend compositor animations; this case verifies editing
    // and persistence using the supported OS reduced-motion preference.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWelcome(page);
    await createPatent(page, patentName);

    await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
    await page.getByRole("menuitem", { name: "权／说" }).click();
    const workspace = page.getByRole("region", { name: "同屏双文档工作区" });
    await expect(workspace).toBeVisible();
    const left = page.getByRole("region", { name: "左侧文档" });
    const right = page.getByRole("region", { name: "右侧文档" });
    const claims = left.getByRole("textbox", { name: "编辑 权利要求书" });
    const description = right.getByRole("textbox", { name: "编辑 说明书" });
    await replaceEditorText(claims, "1. 双显权利要求内容，其特征在于，包括测试部件。 ");
    await replaceEditorText(description, "双显说明书内容。 ");

    await selectDualPane(page, "left");
    await expectActivePane(page, "left");
    const leftZoom = Number(await left.getAttribute("data-dual-zoom"));
    await page.getByRole("button", { name: "放大" }).click();
    await expect(left).toHaveAttribute("data-dual-zoom", String(leftZoom + 10));
    // Lock both documents to explicit manual zoom before testing swap persistence.
    // An automatic fit may legitimately change in the destination pane.
    await selectDualPane(page, "right");
    const automaticRightZoom = Number(await right.getAttribute("data-dual-zoom"));
    await page.getByRole("button", { name: "放大" }).click();
    await expect(right).toHaveAttribute("data-dual-zoom", String(automaticRightZoom + 10));
    const rightZoom = await right.getAttribute("data-dual-zoom");
    await selectDualPane(page, "left");

    await swapDualPanes(page);
    await expect(right.getByRole("textbox", { name: "编辑 权利要求书" })).toBeVisible();
    await expect(left.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();
    await expect(right).toHaveAttribute("data-dual-zoom", String(leftZoom + 10));
    await expect(left).toHaveAttribute("data-dual-zoom", rightZoom ?? "");

    await page.getByRole("button", { name: "保存" }).click();
    await page.getByRole("button", { name: "同屏双显", exact: true }).click();
    await page.getByRole("button", { name: `关闭${patentName}` }).click();
    await application.close();

    application = await workbench.launch();
    page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWelcome(page);
    await reopenPatent(page, patentName);
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书" })).toContainText(
      "双显权利要求内容",
    );
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 说明书" })).toContainText(
      "双显说明书内容",
    );
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("selects an opened patent for the right pane and exits safely when the window is restored", async ({
  workbench,
}) => {
  test.setTimeout(90_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "双显第一专利");
    await createPatent(page, "双显第二专利");

    await enterDualView(page);
    await choosePaneBook(page, "right", "双显第一专利", "权利要求书");
    const right = page.getByRole("region", { name: "右侧文档" });
    await expect(right.getByRole("textbox", { name: "编辑 权利要求书" })).toBeVisible();
    await selectDualPane(page, "right");
    await expectActivePane(page, "right");

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.unmaximize();
    });
    await expect(page.getByRole("region", { name: "同屏双文档工作区" })).toBeHidden();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书" })).toBeVisible();
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") {
      expect(
        await application.evaluate(({ BaseWindow }) =>
          BaseWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
        ),
      ).toBe(true);
    }
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("switches documents from pane headers and closes either pane without duplicating a book", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const patentName = "双显标题切换夹具";
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, patentName);

    await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
    await page.getByRole("menuitem", { name: "权／说" }).click();

    const workspace = page.getByRole("region", { name: "同屏双文档工作区" });
    const left = workspace.getByRole("region", { name: "左侧文档" });
    const right = workspace.getByRole("region", { name: "右侧文档" });
    await expect(left.getByRole("textbox", { name: "编辑 权利要求书" })).toBeVisible();
    await expect(right.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();

    const leftSwitchTriggers = left.getByRole("button", { name: "切换左侧文档" });
    await leftSwitchTriggers.first().click();
    const leftSwitcher = page.getByRole("dialog", { name: "切换左侧文档" });
    await expect(leftSwitcher).toBeVisible();

    const leftSwitcherBox = await leftSwitcher.boundingBox();
    if (!leftSwitcherBox) throw new Error("无法定位左侧文档切换弹层");
    await page.mouse.click(leftSwitcherBox.x + leftSwitcherBox.width - 12, leftSwitcherBox.y + 9);
    await expect(leftSwitcher).toBeVisible();
    await expect(
      leftSwitcher.getByRole("button", { name: "说明书摘要", exact: true }),
    ).toBeVisible();
    await expect(left.getByRole("textbox", { name: "编辑 权利要求书" })).toBeVisible();
    await expect(right.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "切换左侧文档" })).toHaveCount(0);
    await expect(left.getByRole("textbox", { name: "编辑 权利要求书" })).toBeVisible();
    await expect(right.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();

    const rightSwitchTriggers = right.getByRole("button", { name: "切换右侧文档" });
    await rightSwitchTriggers.last().click();
    const rightSwitcher = page.getByRole("dialog", { name: "切换右侧文档" });
    await expect(rightSwitcher).toBeVisible();
    await expect(
      rightSwitcher.getByRole("button", { name: "权利要求书", exact: true }),
    ).toHaveCount(0);
    await expect(rightSwitcher.getByRole("button", { name: "说明书", exact: true })).toHaveCount(0);
    await expect(
      rightSwitcher.getByRole("button", { name: "切换到另一侧的权利要求书" }),
    ).toBeVisible();
    await rightSwitcher.getByRole("button", { name: "说明书摘要", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "切换右侧文档" })).toHaveCount(0);
    await expect(right.getByRole("textbox", { name: "编辑 说明书摘要" })).toBeVisible();
    await expect(left.getByRole("textbox", { name: "编辑 权利要求书" })).toBeVisible();

    await page.getByRole("button", { name: "关闭左侧文档" }).click();
    await expect(page.getByRole("region", { name: "同屏双文档工作区" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "编辑 说明书摘要" })).toBeVisible();

    await enterDualView(page);
    await choosePaneBook(page, "right", patentName, "说明书");
    const reopenedWorkspace = page.getByRole("region", { name: "同屏双文档工作区" });
    const reopenedLeft = reopenedWorkspace.getByRole("region", { name: "左侧文档" });
    const reopenedRight = reopenedWorkspace.getByRole("region", { name: "右侧文档" });
    await expect(reopenedLeft.getByRole("textbox", { name: "编辑 说明书摘要" })).toBeVisible();
    await expect(reopenedRight.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();

    await page.getByRole("button", { name: "关闭右侧文档" }).click();
    await expect(page.getByRole("region", { name: "同屏双文档工作区" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "编辑 说明书摘要" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("keeps equal dual panes while each function rail collapses, hovers, pins and serves its active editor", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "双显功能栏交互夹具");

    const singleRail = page.getByRole("complementary", { name: "说明书全局功能栏" });
    await expect(singleRail.getByRole("button", { name: "固定" })).toHaveCount(0);
    await expect(singleRail.getByRole("button", { name: "收起功能栏" })).toHaveCount(0);

    await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
    await page.getByRole("menuitem", { name: "权／说" }).click();

    const workspace = page.getByRole("region", { name: "同屏双文档工作区" });
    const left = workspace.getByRole("region", { name: "左侧文档" });
    const right = workspace.getByRole("region", { name: "右侧文档" });
    await expect(workspace).toBeVisible();
    await expectMatchingWidths(left, right);

    const leftRail = left.getByRole("complementary", { name: "权利要求书全局功能栏" });
    // Start with enough room for two full pages and docked rails before testing collapse.
    await page.setViewportSize({ width: 2600, height: 1080 });
    await expectRenderedWidth(leftRail, 280);
    await expect(leftRail.getByRole("button", { name: "固定" })).toHaveCount(0);
    await expect(leftRail.getByRole("button", { name: "收起功能栏" })).toHaveCount(0);
    await left.getByRole("textbox", { name: "编辑 权利要求书" }).click();
    const leftExpand = await zoomActivePaneUntilRailCollapses(page, left);
    await expectRenderedWidth(leftExpand, 36);
    await expectMatchingRightEdges(leftExpand, left);

    await movePointerTo(page, leftExpand);
    await expectRenderedWidth(leftRail, 280);
    await expectRightInset(leftRail, left, 48);
    await movePointerAwayFromRail(page, left);
    await expect(leftExpand).toBeVisible();

    await movePointerTo(page, leftExpand);
    await expect(leftRail).toBeVisible();
    await leftRail.getByRole("button", { name: "固定", exact: true }).click();
    await movePointerAwayFromRail(page, left);
    await expect(leftRail).toBeVisible();
    await expectRightInset(leftRail, left, 48);
    await expect(leftRail.getByRole("button", { name: "取消固定" })).toBeVisible();
    await leftRail.getByRole("button", { name: "收起功能栏" }).click();
    await expect(leftExpand).toBeVisible();

    await left.getByRole("textbox", { name: "编辑 权利要求书" }).click();
    await expectActivePane(page, "left");
    await page.keyboard.press("Control+f");
    await expect(left.getByRole("search", { name: "查找和替换" })).toBeVisible();
    await expect(right.getByRole("search", { name: "查找和替换" })).toHaveCount(0);
    await left.getByRole("button", { name: "关闭查找" }).click();
    await movePointerAwayFromRail(page, left);
    await expectRenderedWidth(leftExpand, 36);

    const rightRail = right.getByRole("complementary", { name: "说明书全局功能栏" });
    await expectRenderedWidth(rightRail, 280);
    await expect(rightRail.getByRole("button", { name: "固定" })).toHaveCount(0);
    await expect(rightRail.getByRole("button", { name: "收起功能栏" })).toHaveCount(0);
    await right.getByRole("textbox", { name: "编辑 说明书" }).click();
    const rightExpand = await zoomActivePaneUntilRailCollapses(page, right);
    await expectRenderedWidth(rightExpand, 36);
    await expectMatchingRightEdges(rightExpand, right);
    await zoomActivePaneUntilRailDocks(page, rightRail, right);
    const rightZoomAfterRestore = await right.getAttribute("data-dual-zoom");
    await expectRenderedWidth(rightRail, 280);
    await expect(rightRail).toBeVisible();
    await expect(rightRail.getByRole("button", { name: "固定" })).toHaveCount(0);
    await expect(rightRail.getByRole("button", { name: "收起功能栏" })).toHaveCount(0);
    await right.getByRole("textbox", { name: "编辑 说明书" }).click();
    await page.keyboard.press("Control+h");
    await expect(right.getByRole("textbox", { name: "替换为" })).toBeVisible();
    await expectRenderedWidth(rightRail, 280);
    await expect(rightRail.getByRole("button", { name: "收起功能栏" })).toHaveCount(0);
    await expect(left.getByRole("search", { name: "查找和替换" })).toHaveCount(0);
    await right.getByRole("button", { name: "关闭查找" }).click();
    await expectRenderedWidth(rightRail, 280);

    await expect(right).toHaveAttribute("data-dual-zoom", rightZoomAfterRestore ?? "");
  } finally {
    await application.close().catch(() => undefined);
  }
});

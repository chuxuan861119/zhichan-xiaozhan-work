import type { Editor } from "@tiptap/core";
import { columnScrollbar } from "./helpers/column-scrollbar.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("selection changes keep the opposite ruler and markers mounted", async ({ workbench }) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双列标尺稳定性验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
  await editor.evaluate((element) => {
    (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: "doc",
      content: Array.from({ length: 80 }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `${index + 1}. 一种装置，其特征在于：底座连接支撑杆。` }],
      })),
    });
  });
  await page.setViewportSize({ width: 2200, height: 1000 });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  await columnScrollbar(page).fill("0");
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.runFor(500);
  for (const side of [0, 1]) {
    const bounds = await layout.boundingBox();
    if (!bounds) throw new Error("Missing columns");
    const width = await layout.evaluate((element) =>
      Number.parseFloat((element as HTMLElement).style.getPropertyValue("--column-width")),
    );
    const x = bounds.x + side * (width + 20) + width / 2;
    // Native selection may scroll its viewport; keep the next drag inside visible text.
    const viewportTop = await layout.evaluate(
      (element) => element.closest(".editor-workspace")?.getBoundingClientRect().top ?? 0,
    );
    const y = Math.max(bounds.y, viewportTop) + 250;
    await page.mouse.move(x, y);
    await page.clock.runFor(48);
    await expect(layout).toHaveAttribute("data-active-column", String(side));
    await page.clock.runFor(100);
    const mirror = layout.locator(
      `.dual-column-paper[data-side="${1 - side}"] .document-structure-ruler`,
    );
    const ruler = await mirror.elementHandle();
    const marker = await mirror
      .locator(".document-structure-ruler__marker")
      .first()
      .elementHandle();
    if (!ruler || !marker) throw new Error("Missing mirrored ruler");
    await page.mouse.down();
    try {
      for (let step = 0; step < 4; step++) {
        await page.mouse.move(x + step * 8, y + 40 + step * 38);
        await page.clock.runFor(48);
        expect(await ruler.evaluate((element) => element.isConnected)).toBe(true);
        expect(await marker.evaluate((element) => element.isConnected)).toBe(true);
      }
    } finally {
      await page.mouse.up();
      await page.clock.runFor(48);
    }
    const selection = await editor.evaluate((element) => {
      const { from, to } = (element as HTMLElement & { editor: Editor }).editor.state.selection;
      return to - from;
    });
    expect(selection).toBeGreaterThan(0);
    const liveLabels = await layout
      .locator(":scope > .document-structure-ruler [data-active=true]")
      .allTextContents();
    await expect(mirror.locator("[data-active=true]")).toHaveText(liveLabels);
  }
  // Keeping marker nodes must not prevent later document edits from reaching the mirror.
  await editor.evaluate((element) =>
    (element as HTMLElement & { editor: Editor }).editor.commands.insertContent("同步编辑验收"),
  );
  await page.clock.runFor(300);
  await expect(layout.locator('.dual-column-paper[data-side="0"] .dual-column-copy')).toContainText(
    "同步编辑验收",
  );
});

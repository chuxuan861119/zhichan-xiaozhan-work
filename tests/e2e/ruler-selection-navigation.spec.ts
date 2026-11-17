import type { Editor } from "@tiptap/core";
import { columnScrollbar } from "./helpers/column-scrollbar.js";
import { choosePaneBook, dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

for (const mode of ["single", "columns", "dual"] as const) {
  for (const clickCount of [1, 2]) {
    test(`${mode}, ${clickCount} click(s): held selection uses the ruler then resumes in the document`, async ({
      workbench,
    }, testInfo) => {
      const app = await workbench.launchAllowMultipleInstances();
      const page = await app.firstWindow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await dismissWorkbenchWelcome(page);
      await page.getByRole("button", { name: "新建专利", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
      await dialog.getByRole("textbox", { name: "专利名称" }).fill("标尺拖选导航验收");
      await dialog.getByRole("radio", { name: "发明", exact: true }).check();
      await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
      await page.setViewportSize({ width: 2200, height: 1000 });
      let editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
      await editor.evaluate((element) => {
        (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
          type: "doc",
          content: Array.from({ length: 100 }, (_, i) => ({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: `${i + 1}. 一种装置，其特征在于：底座连接支撑杆，支撑杆连接固定板。`,
              },
            ],
          })),
        });
      });
      if (mode === "columns")
        await page.getByRole("button", { name: "双列显示", exact: true }).click();
      if (mode === "dual") {
        await page.getByRole("button", { name: "同屏双显", exact: true }).click();
        await choosePaneBook(page, "right", "标尺拖选导航验收", "说明书");
        editor = page
          .getByRole("region", { name: "左侧文档", exact: true })
          .getByRole("textbox", { name: "编辑 权利要求书", exact: true });
      }
      await expect(editor).toBeVisible();
      await editor.evaluate((element) =>
        (element as HTMLElement & { editor: Editor }).editor.commands.focus("start"),
      );
      // Native window sizing and the initial fit-to-width animation settle before the gesture.
      await page.waitForTimeout(1200);
      const layout = editor.locator(
        "xpath=ancestor::*[contains(@class,'patent-page-with-rail')][1]",
      );
      await page.waitForTimeout(1000);
      if (mode === "columns") await columnScrollbar(page).fill("0");
      else
        await editor.evaluate((element) => {
          const viewport = element.closest<HTMLElement>(".editor-workspace");
          if (viewport) viewport.scrollTop = 0;
        });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      const unchangedDocument = await editor.evaluate((element) =>
        (element as HTMLElement & { editor: Editor }).editor.getJSON(),
      );
      const point = await editor.evaluate((element) => {
        const e = (element as HTMLElement & { editor: Editor }).editor;
        const r = e.view.coordsAtPos(5);
        return { x: r.left, y: (r.top + r.bottom) / 2 };
      });
      const anchorOf = () =>
        editor.evaluate((element) => {
          const s = (element as HTMLElement & { editor: Editor }).editor.state.selection;
          return { anchor: s.anchor, head: s.head };
        });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down({ clickCount });
      await page.mouse.move(point.x + 60, point.y + 25);
      await page.clock.runFor(32);
      const initial = await anchorOf();
      const ruler = await layout.locator(":scope > .document-structure-ruler").boundingBox();
      if (!ruler) throw new Error("Missing ruler");
      const railPoint = { x: ruler.x + ruler.width / 2, y: point.y + 40 };
      if (mode === "columns")
        railPoint.x += await layout.evaluate(
          (element) =>
            Number.parseFloat((element as HTMLElement).style.getPropertyValue("--column-width")) +
            20,
        );
      await page.mouse.move(railPoint.x, railPoint.y);
      await page.clock.runFor(900);
      await expect(page.locator('[data-selection-navigation="true"]')).toHaveCount(0);
      await page.clock.runFor(200);
      const nav = page.locator('[data-selection-navigation="true"]');
      await expect(nav).toBeVisible();
      const target = nav.getByRole("button", { name: "权利要求 24", exact: true });
      const targetBounds = await target.boundingBox();
      if (!targetBounds) throw new Error("Missing navigation target");
      await page.mouse.move(targetBounds.x + 35, targetBounds.y + targetBounds.height / 2);
      await page.clock.runFor(145);
      const selected = await anchorOf();
      expect(selected.anchor).toBe(initial.anchor);
      expect(selected.head).toBeGreaterThan(initial.head + 200);
      // Interrupt the scroll outside the document and return to the exact same marker.
      const scrollPosition = () =>
        layout.evaluate((element) =>
          Number(
            (element as HTMLElement).dataset.columnPosition ??
              element.closest(".editor-workspace")?.scrollTop,
          ),
        );
      await page.mouse.move(2100, 50);
      await page.clock.runFor(32);
      const interrupted = await scrollPosition();
      await page.mouse.move(targetBounds.x + 35, targetBounds.y + targetBounds.height / 2);
      await page.clock.runFor(600);
      expect(await scrollPosition()).toBeGreaterThan(interrupted + 50);
      expect(await anchorOf()).toEqual(selected);
      const nativeSelection = await editor.evaluate((element) => {
        const e = (element as HTMLElement & { editor: Editor }).editor;
        const s = window.getSelection();
        return {
          anchor: s?.anchorNode ? e.view.posAtDOM(s.anchorNode, s.anchorOffset) : null,
          head: s?.focusNode ? e.view.posAtDOM(s.focusNode, s.focusOffset) : null,
        };
      });
      expect(nativeSelection).toEqual(selected);
      expect(await editor.evaluate((element) => getComputedStyle(element).userSelect)).not.toBe(
        "none",
      );
      await page.screenshot({ path: testInfo.outputPath("active-selection-navigation.png") });
      if (mode === "dual") {
        const other = page.getByRole("region", { name: "右侧文档", exact: true });
        const otherRail = await other.locator(".document-structure-ruler").boundingBox();
        const before = await other
          .locator(".editor-workspace")
          .evaluate((element) => element.scrollTop);
        if (!otherRail) throw new Error("Missing second pane ruler");
        await page.mouse.move(otherRail.x + otherRail.width / 2, point.y + 40);
        await page.clock.runFor(1100);
        expect(await anchorOf()).toEqual(selected);
        expect(
          await other.locator(".editor-workspace").evaluate((element) => element.scrollTop),
        ).toBe(before);
      }
      // Returning to actual text must keep the original anchor, not start a new selection.
      const finish = await editor.evaluate((element, position) => {
        const r = (element as HTMLElement & { editor: Editor }).editor.view.coordsAtPos(position);
        return { x: r.left - 10, y: (r.top + r.bottom) / 2 };
      }, selected.head - 5);
      await page.mouse.move(finish.x, finish.y);
      await page.clock.runFor(32);
      expect((await anchorOf()).head).toBeGreaterThan(initial.head + 200);
      expect((await anchorOf()).anchor).toBe(initial.anchor);
      const edge = await layout.evaluate((element, x) => {
        const el = element as HTMLElement;
        const viewport = el.closest(".editor-workspace")!.getBoundingClientRect();
        let bottom = viewport.bottom;
        if (el.dataset.columnHeight) {
          const r = el.getBoundingClientRect();
          const width = Number.parseFloat(el.style.getPropertyValue("--column-width"));
          const side = x > r.left + width ? 1 : 0;
          bottom = Math.min(bottom, r.top + side * 20 + Number(el.dataset.columnHeight));
        }
        return { x, y: bottom - 5 };
      }, finish.x);
      await page.mouse.move(edge.x, edge.y);
      await page.clock.runFor(32);
      const edgeStart = await scrollPosition();
      const edgeSelection = await anchorOf();
      await page.clock.runFor(500);
      expect(await scrollPosition()).toBeGreaterThan(edgeStart + 50);
      expect((await anchorOf()).anchor).toBe(initial.anchor);
      expect((await anchorOf()).head).toBeGreaterThan(edgeSelection.head);
      await page.mouse.move(finish.x, finish.y);
      await page.clock.runFor(32);
      const stoppedEdge = await scrollPosition();
      await page.clock.runFor(200);
      expect(await scrollPosition()).toBe(stoppedEdge);
      await page.mouse.up();
      await page.clock.runFor(50);
      await expect(nav).toHaveCount(0);
      const final = await anchorOf();
      expect(final.anchor).toBe(initial.anchor);
      expect(final.head).toBeGreaterThan(initial.head + 200);
      await page.clock.runFor(1200);
      expect(await anchorOf()).toEqual(final);
      await expect(layout).not.toHaveAttribute("data-ruler-selection-drag");
      expect(
        await editor.evaluate((element) =>
          (element as HTMLElement & { editor: Editor }).editor.getJSON(),
        ),
      ).toEqual(unchangedDocument);

      // Reverse selection, then abort without releasing the physical button.
      await editor.evaluate(
        (element, position) =>
          (element as HTMLElement & { editor: Editor }).editor.commands.setTextSelection(position),
        final.head,
      );
      await page.mouse.move(finish.x, finish.y);
      await page.mouse.down();
      const reverseAnchor = (await anchorOf()).anchor;
      const liveRail = await layout.locator(":scope > .document-structure-ruler").boundingBox();
      if (!liveRail) throw new Error("Missing live ruler");
      await page.mouse.move(liveRail.x + liveRail.width / 2, finish.y);
      await page.clock.runFor(1100);
      await expect(nav).toBeVisible();
      await nav.getByRole("button", { name: "权利要求 1", exact: true }).scrollIntoViewIfNeeded();
      const first = await nav
        .getByRole("button", { name: "权利要求 1", exact: true })
        .boundingBox();
      if (!first) throw new Error("Missing first paragraph");
      await page.mouse.move(first.x + 30, first.y + first.height / 2);
      await page.clock.runFor(140);
      expect((await anchorOf()).anchor).toBe(reverseAnchor);
      expect((await anchorOf()).head).toBe(1);
      await page.keyboard.press("Escape");
      const cancelled = await anchorOf();
      const stopped = await layout.evaluate((element) => ({
        position: (element as HTMLElement).dataset.columnPosition,
        scroll: element.closest(".editor-workspace")?.scrollTop,
      }));
      await page.mouse.move(finish.x - 20, finish.y + 10);
      await page.clock.runFor(1100);
      expect(await anchorOf()).toEqual(cancelled);
      expect(
        await layout.evaluate((element) => ({
          position: (element as HTMLElement).dataset.columnPosition,
          scroll: element.closest(".editor-workspace")?.scrollTop,
        })),
      ).toEqual(stopped);
      await expect(nav).toHaveCount(0);
      await page.mouse.up();
    });
  }
}

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

test("manual page creation is unavailable while imported pages remain editable", async ({ page }) => {
  const root = resolve("resources/drawio/app");
  await page.route("http://drawio.test/**", async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) return route.abort();
    try {
      const body = await readFile(file);
      const contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "application/octet-stream";
      await route.fulfill({ body, contentType });
    } catch { await route.fulfill({ status: 404, body: "" }); }
  });
  await page.addInitScript(() => {
    window.addEventListener("load", () => {
      const runtime = window as any;
      const original = runtime.EditorUi.prototype.init;
      runtime.EditorUi.prototype.init = function (...args: unknown[]) {
        runtime.testUi = this;
        return original.apply(this, args);
      };
    });
  });
  await page.goto("http://drawio.test/embed.html?offline=1&local=1");
  await page.waitForFunction(() => Boolean((window as any).testUi?.actions));
  const result = await page.evaluate(() => {
    const ui = (window as any).testUi;
    ui.setFileData('<mxfile><diagram id="one" name="第一页"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram><diagram id="two" name="第二页"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>');
    ui.updateTabContainer();
    const blocked = ["insertPage", "duplicatePage"].map((name) => {
      const action = ui.actions.get(name);
      action.funct();
      return { enabled: action.isEnabled(), visible: action.isVisible() };
    });
    ui.selectPage(ui.pages[1]);
    const graph = ui.editor.graph;
    graph.insertVertex(graph.getDefaultParent(), "test-cell", "仍可编辑", 10, 10, 100, 30);
    const saved = ui.getFileData();
    const menu = new (window as any).mxPopupMenu();
    menu.init();
    menu.showDisabled = true;
    ui.createPageMenu(ui.currentPage)(menu, null);
    const pageMenu = menu.div.textContent;
    menu.destroy();
    ui.setFileData(saved);
    ui.selectPage(ui.pages[1]);
    const restoredCell = ui.editor.graph.getModel().getCell("test-cell");
    const restoredValue = restoredCell?.value;
    return {
      blocked,
      count: ui.pages.length,
      selected: ui.currentPage.getId(),
      tabs: ui.tabContainer.querySelectorAll(".gePageTab").length,
      insertTabVisible: ui.isPageInsertTabVisible(),
      saved,
      restoredValue,
      pageMenu,
      duplicateLabel: (window as any).mxResources.get("duplicateIt", [(window as any).mxResources.get("page")]),
    };
  });
  expect(result.blocked).toEqual([{ enabled: false, visible: false }, { enabled: false, visible: false }]);
  expect(result.count).toBe(2);
  expect(result.selected).toBe("two");
  expect(result.tabs).toBe(2);
  expect(result.insertTabVisible).toBe(false);
  expect(result.saved).toContain('id="one"');
  expect(result.saved).toContain('id="two"');
  expect(result.restoredValue).toBe("仍可编辑");
  expect(result.pageMenu).not.toContain(result.duplicateLabel);
});

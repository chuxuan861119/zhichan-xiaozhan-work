import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

test("flowchart menus share the application shadow without duplicating it on their inner table", async ({
  page,
}) => {
  await page.setContent(
    '<body class="geEditor"><div role="menu" id="reference">标准菜单</div><div class="mxPopupMenu"><table class="mxPopupMenu"><tbody><tr><td>流程图菜单</td></tr></tbody></table></div></body>',
  );
  for (const file of [
    "resources/drawio/app/mxgraph/css/common.css",
    "resources/drawio/app/patent-toolbar.css",
    "resources/ui/workbench-ui.css",
  ]) {
    await page.addStyleTag({ content: readFileSync(file, "utf8") });
  }
  for (const dark of [false, true]) {
    await page.evaluate((dark) => document.body.classList.toggle("geDarkMode", dark), dark);
    const shadows = await page.evaluate(() => ({
      reference: getComputedStyle(document.getElementById("reference")!).boxShadow,
      outer: getComputedStyle(document.querySelector("div.mxPopupMenu")!).boxShadow,
      inner: getComputedStyle(document.querySelector("table.mxPopupMenu")!).boxShadow,
    }));
    expect(shadows.outer).toBe(shadows.reference);
    expect(shadows.inner).toBe("none");
  }
});

test("bundled surface reset preserves shadows on floating menus and color panels", async ({
  page,
}) => {
  const surfaces = [
    ["CAD工具菜单", '<div class="cad-tool-menu" role="menu">选项</div>'],
    ["文字颜色", '<section class="color-palette" role="dialog">颜色</section>'],
    ["其他颜色", '<section class="custom-color-popup" role="dialog">其他颜色</section>'],
    ["编辑菜单", '<div class="file-menu" role="menu">编辑</div>'],
    ["专利库菜单", '<div class="library-import-menu__panel" role="menu">导入</div>'],
    ["插入表格", '<div class="insert-table-popover">表格</div>'],
    ["双屏切换", '<div class="dual-document-pane__switcher-popover">切换</div>'],
    ["绘图样式", '<div class="drawing-style-popover">线条</div>'],
    ["分享菜单", '<div id="shareMenuBottom">分享</div>'],
    ["流程图菜单", '<div class="mxPopupMenu">选项</div>'],
  ];
  await page.setContent(
    surfaces.map(([name, html]) => `<div data-surface="${name}">${html}</div>`).join(""),
  );
  await page.addStyleTag({ content: readFileSync("resources/ui/workbench-ui.css", "utf8") });
  const missing = await page
    .locator("[data-surface] > *")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => getComputedStyle(node).boxShadow === "none")
        .map((node) => node.parentElement?.getAttribute("data-surface")),
    );
  expect(missing).toEqual([]);
  const contours = await page.locator("[data-surface] > *").evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.borderTopWidth !== "0px" || style.boxShadow.includes("0px 0px 0px 1px");
      })
      .map((node) => node.parentElement?.getAttribute("data-surface")),
  );
  expect(contours).toEqual([]);
});

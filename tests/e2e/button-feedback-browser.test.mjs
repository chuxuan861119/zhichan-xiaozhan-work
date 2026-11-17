import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const source = new URL("../../src/renderer/src/", import.meta.url);
async function styles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = new URL(entry.name, directory);
      if (entry.isDirectory()) return styles(new URL(`${entry.name}/`, directory));
      if (!entry.name.endsWith(".css") || entry.name === "button-feedback.css") return "";
      return readFile(path, "utf8");
    }),
  );
  return files.join("\n");
}
const featureCss =
  (await styles(source)) +
  (await readFile(new URL("../../resources/ui/workbench-ui.css", import.meta.url), "utf8"));
const feedbackCss = await readFile(new URL("shared/button-feedback.css", source), "utf8");

function button(className = "", ancestors = [], attributes = "", tag = "button") {
  const content =
    tag === "select"
      ? '<option value="first">正文</option><option value="second">标题</option>'
      : "操作";
  let markup = `<${tag} id="target" class="${className}" ${attributes}>${content}</${tag}>`;
  for (const ancestor of ancestors.toReversed()) {
    markup = `<div class="${ancestor}">${markup}</div>`;
  }
  return markup;
}

const cases = [
  ["菜单", "", ["menu-bar", "menu-bar__menu-group"]],
  ["文件菜单项", "", ["menu-bar", "file-menu"]],
  ["五书", "patent-book-tabs__tab", ["menu-bar", "patent-book-tabs"]],
  ["五书辅助添加", "patent-book-tabs__auxiliary-add", ["menu-bar"]],
  ["五书辅助菜单", "", ["menu-bar", "patent-book-tabs__auxiliary-menu--actions"]],
  ["多栏布局", "", ["menu-bar", "patent-split-controls__buttons"]],
  ["多栏预设", "patent-split-controls__custom-preset", ["menu-bar"]],
  ["流程图标签关闭", "menu-bar__flowchart-tab-close", ["menu-bar"]],
  ["标签关闭", "tab-close"],
  ["新增标签", "new-tab-button"],
  ["专利关闭", "patent-tabs__close-patent"],
  ["专利列表", "patent-tabs__overflow-trigger"],
  ["工具按钮", "tool-button", ["tool-bar"]],
  ["正文下拉", "style-select", ["tool-bar"], "", "select"],
  ["字体下拉", "font-select", ["tool-bar"], "", "select"],
  ["字号下拉", "size-select", ["tool-bar"], "", "select"],
  ["打印下拉", "", ["print-center-dialog"], "", "select"],
  ["折叠菜单", "", ["text-polish-panel"], "", "summary"],
  ["导入菜单项", "", ["tool-bar", "toolbar-import-menu"]],
  ["导出菜单项", "", ["tool-bar", "toolbar-export-menu"]],
  ["更多工具菜单项", "", ["tool-bar", "toolbar-overflow-menu"]],
  ["颜色主按钮", "color-picker-main", ["tool-bar", "text-color-picker", "color-picker-split"]],
  ["颜色箭头", "color-picker-dropdown", ["tool-bar", "text-color-picker", "color-picker-split"]],
  ["颜色自动选择", "color-palette-automatic", ["color-palette"]],
  ["颜色自定义", "color-palette-custom", ["color-palette"]],
  ["选区工具", "", ["editor-mini-row"]],
  ["文档库工具", "", ["library-header"]],
  ["文档库主按钮", "primary-button", ["library-header"]],
  ["专利卡片操作", "", ["library-card-actions"]],
  ["专利卡片菜单", "", ["patent-card-menu-panel"]],
  ["文档库视图", "", ["patent-library-view-toggle"]],
  ["设置操作", "settings-action-button"],
  ["设置页面导航", "settings-workspace-navigation__item"],
  ["设置面包屑", "", ["settings-workspace-breadcrumb"]],
  ["模板字段", "", ["template-catalog__tool-group--fields"]],
  ["模板菜单", "", ["template-catalog-card__overflow-menu"]],
  ["模板激活", "template-catalog-card__activate"],
  ["主题预设", "", ["editor-color-presets"]],
  ["配色下拉", "editor-color-picker__trigger", ["editor-color-controls"]],
  [
    "设置内联保存",
    "",
    ["application-settings-dialog", "settings-workspace-content", "preference-footer"],
  ],
  ["设置数据操作", "", ["application-settings-dialog__actions"]],
  ["普通弹窗确认", "primary-button", ["patent-dialog", "dialog-actions"]],
  ["普通弹窗取消", "", ["dialog-actions"]],
  ["标准弹窗关闭", "standard-dialog__close dialog-close-control", ["standard-dialog"]],
  ["工具弹窗关闭", "dialog-close-button dialog-close-control", ["formula-dialog"]],
  ["公式操作", "", ["formula-dialog"]],
  ["物理公式", "", ["other-formula-dialog", "other-formula-group"]],
  ["物理公式确认", "primary-button", ["other-formula-dialog__actions"]],
  ["化学工具", "chemistry-icon-btn"],
  ["特殊符号", "special-character-dialog__option"],
  ["周期表分类", "periodic-tab"],
  ["打印主操作", "primary-button", ["print-center-dialog", "print-center-actions"]],
  ["打印更多设置", "print-more-toggle"],
  ["绘图工具", "drawing-tool-button", ["drawing-workspace"]],
  ["绘图主操作", "drawing-primary", ["drawing-workspace"]],
  ["附图导入", "", ["compact-drawing-actions", "compact-drawing-import"]],
  ["流程图菜单", "", ["flowchart-project-menu"]],
  ["内置流程图导出", "geBtn", ["geDialog"]],
  ["内置流程图工具", "patent-toolbar__button", ["patent-toolbar"]],
  ["流程图导出", "flowchart-export-choice-card", ["flowchart-dialog"]],
  ["侧栏操作", "", ["patent-global-function-rail", "patent-book-tools compact-tool-actions"]],
  [
    "侧栏表格操作",
    "table-rail-panel__button",
    ["patent-global-function-rail", "table-rail-panel__buttons"],
  ],
  ["侧栏折叠", "table-rail-panel__group-toggle", ["patent-global-function-rail"]],
  ["问题检查", "", ["patent-check-panel"]],
  ["AI 操作", "ai-icon-button", ["text-polish-panel"]],
  ["AI 模型操作", "", ["ai-model-card__actions"]],
  ["备份操作", "", ["backup-manager__actions"]],
  ["数据迁移", "primary-button", ["data-transfer-wizard-actions"]],
  ["快照导航", "", ["snapshot-content-preview__navigation"]],
  ["法律文档导航", "", ["legislation-reader"]],
  ["帮助关闭", "", ["ai-experimental-popover__heading"]],
  ["状态栏缩放", "status-zoom-btn"],
  ["自定义可点击控件", "", [], 'role="button" tabindex="0"', "span"],
];

async function setup(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(`<style>${featureCss}</style><style id="feedback"></style>
    <style>
      *, *::before, *::after { transition-duration:0s!important; animation:none!important; }
      body { height:auto; overflow:auto; }
      #fixture { position:relative; margin:40px; }
      #fixture div { display:block!important; position:static!important; width:auto!important; height:auto!important; overflow:visible!important; transform:none!important; animation:none!important; }
      #target { display:inline-flex!important; position:relative!important; visibility:visible!important; min-height:30px; min-width:30px; animation:none!important; }
    </style><div id="fixture"></div>`);
  return page;
}

async function put(page, markup, feedback = true) {
  await page.mouse.move(1100, 700);
  await page.evaluate(
    ({ markup, css }) => {
      document.querySelector("#fixture").innerHTML = markup;
      document.querySelector("#feedback").textContent = css;
    },
    { markup, css: feedback ? feedbackCss : "" },
  );
  return page.locator("#target");
}

async function appearance(target) {
  return target.evaluate((node) => {
    const css = getComputedStyle(node),
      box = node.getBoundingClientRect();
    return {
      background: css.backgroundColor,
      color: css.color,
      radius: css.borderRadius,
      shadow: css.boxShadow,
      width: box.width,
      height: box.height,
      outline: css.outlineStyle,
    };
  });
}

test(`${cases.length} application action controls share the five-book hover without changing their size`, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await setup(browser);
    const reference = await put(page, button("patent-book-tabs__tab", ["menu-bar"]), false);
    await reference.hover();
    const expected = await appearance(reference);
    assert.equal(expected.radius, "6px");
    assert.equal(expected.background, "rgb(237, 241, 246)");
    for (const [name, className, ancestors, attributes, tag] of cases) {
      const target = await put(page, button(className, ancestors, attributes, tag));
      const before = await appearance(target);
      await target.hover();
      const after = await appearance(target);
      assert.equal(after.radius, expected.radius, name);
      assert.equal(after.background, expected.background, name);
      assert.equal(after.color, expected.color, name);
      assert.equal(after.shadow, "none", `${name} shadow`);
      assert.equal(after.width, before.width, `${name} width`);
      assert.equal(after.height, before.height, `${name} height`);
    }
  } finally {
    await browser.close();
  }
});

test("selected, disabled, color and editing controls retain their visual meaning", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await setup(browser);
    const preserved = [
      button("patent-book-tabs__tab is-active", ["menu-bar"], 'aria-selected="true"'),
      button("tool-button is-active", ["tool-bar"], 'aria-pressed="true"'),
      button("settings-workspace-navigation__item", [], 'aria-current="page"'),
      button("table-rail-panel__button is-active", ["patent-global-function-rail"]),
      button("primary-button", ["dialog-actions"], "disabled"),
      button("ActionButton-module_selected__fixture", ["ketcher-editor-shell"]),
      button("ketcher-more-tools-button", ["ketcher-editor-shell"], 'aria-expanded="true"'),
      button("tool-button", ["tool-bar"], 'aria-disabled="true"'),
      button("table-rail-panel__button", [], 'data-unavailable="true"'),
      button("color-swatch", ["color-palette"], 'style="background:#ff0000"'),
      button("", ["editor-color-picker__grid"], 'style="background:#ffff00"'),
      button("periodic-cell", [], 'style="background:#a4ddfa"'),
      button("is-active", ["insert-table-popover__grid"]),
      button("table-selection-handle"),
      button("table-insert-handle"),
      button("image-resize-handle"),
      button("flowchart-project-menu-scrim", ["flowchart-project-menu-layer"]),
      button("ai-settings-overlay__backdrop", ["ai-settings-overlay"]),
      button("shortcut-settings-dialog__backdrop", ["shortcut-settings-dialog"]),
      button(
        "reference-mark-locator__switch",
        ["patent-global-function-rail"],
        'role="switch" aria-checked="true"',
      ),
    ];
    for (const markup of preserved) {
      let target = await put(page, markup, false);
      await target.hover();
      const before = await appearance(target);
      target = await put(page, markup);
      await target.hover();
      const after = await appearance(target);
      assert.equal(after.background, before.background, markup);
      assert.equal(after.color, before.color, markup);
      assert.equal(after.width, before.width, markup);
      assert.equal(after.height, before.height, markup);
    }
    const target = await put(page, button("tool-button", ["tool-bar"]));
    await target.focus();
    assert.notEqual((await appearance(target)).outline, "none");
    await target.evaluate((node) => {
      node.addEventListener("click", () => {
        node.dataset.clicked = "true";
      });
    });
    await page.keyboard.press("Space");
    assert.equal(await target.getAttribute("data-clicked"), "true");

    const select = await put(page, button("style-select", ["tool-bar"], "", "select"));
    await select.click();
    await page.keyboard.press("Escape");
    assert.equal(await select.inputValue(), "first");
    await select.click();
    await select.locator('option[value="second"]').click();
    assert.equal(await select.inputValue(), "second");
  } finally {
    await browser.close();
  }
});

test("native disclosures use one line chevron and retain mouse and keyboard toggling", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await setup(browser);
    const target = await put(
      page,
      '<details class="settings-advanced-options"><summary id="target">双列效果</summary><p>内容</p></details>',
    );
    const arrow = () =>
      target.evaluate((node) => {
        const css = getComputedStyle(node, "::before");
        return {
          mask: css.maskImage,
          width: css.width,
          transform: css.transform,
          marker: getComputedStyle(node, "::marker").content,
        };
      });
    const closed = await arrow();
    assert.match(closed.mask, /stroke-width/);
    assert.equal(closed.width, "14px");
    assert.equal(closed.marker, '""');
    await target.hover();
    assert.equal((await appearance(target)).radius, "6px");
    assert.equal((await appearance(target)).shadow, "none");
    await target.click();
    assert.equal(await target.evaluate((node) => node.parentElement.open), true);
    assert.notEqual((await arrow()).transform, closed.transform);
    await target.focus();
    await page.keyboard.press("Space");
    assert.equal(await target.evaluate((node) => node.parentElement.open), false);
    await target.evaluate((node) => {
      node.innerHTML = '<svg width="14" height="14"><path d="M9 6l6 6-6 6" /></svg>已有图标';
    });
    assert.equal((await arrow()).mask, "none");
  } finally {
    await browser.close();
  }
});

test("physics actions and real flowchart export cards animate without delaying selection", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      "<style>" +
        featureCss +
        "</style><style>" +
        feedbackCss +
        "</style>" +
        '<div class="other-formula-group"><button id="physics">公式</button></div>' +
        '<div class="flowchart-dialog"><label class="flowchart-export-choice-card"><input type="radio" name="target"><span>导出</span></label></div>',
    );
    for (const selector of ["#physics", ".flowchart-export-choice-card"]) {
      const timing = await page.locator(selector).evaluate((e) => ({
        duration: getComputedStyle(e).transitionDuration,
        easing: getComputedStyle(e).transitionTimingFunction,
      }));
      assert.equal(timing.duration, "0.4s");
      assert.equal(timing.easing, "ease-in-out");
    }
    await page.locator(".flowchart-export-choice-card").click();
    assert.equal(await page.locator("input").isChecked(), true);
    await page.waitForTimeout(450);
    const selected = await page
      .locator("label")
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    assert.equal(selected, "rgb(239, 246, 255)");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await page.locator("#physics").evaluate((e) => getComputedStyle(e).transitionDuration),
      "0s",
    );
  } finally {
    await browser.close();
  }
});

test("embedded flowchart export buttons receive feedback without the renderer stylesheet", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const css = await readFile(
      new URL("../../resources/ui/workbench-ui.css", import.meta.url),
      "utf8",
    );
    const bundledCss = await readFile(
      new URL("../../resources/drawio/app/styles/grapheditor.css", import.meta.url),
      "utf8",
    );
    await page.setContent(
      "<style>" +
        bundledCss +
        "\n" +
        css +
        '</style><div class="geDialog"><button class="geBtn">导出</button></div>',
    );
    const button = page.locator("button");
    assert.equal(await button.evaluate((e) => getComputedStyle(e).borderRadius), "6px");
    await button.hover();
    await page.waitForTimeout(450);
    const state = await button.evaluate((e) => ({
      background: getComputedStyle(e).backgroundColor,
      duration: getComputedStyle(e).transitionDuration,
    }));
    assert.equal(state.background, "rgb(237, 241, 246)");
    assert.ok(state.duration.split(", ").every((d) => d === "0.4s"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await button.evaluate((e) => getComputedStyle(e).transitionDuration), "0s");
  } finally {
    await browser.close();
  }
});

test("dialog action buttons are rounded before hover, including disabled actions", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await setup(browser);
    const source = await readFile(
      new URL("editor/ui/formula-dialog.tsx", new URL("../../src/renderer/src/", import.meta.url)),
      "utf8",
    );
    const physicsFooter = source.match(
      /<footer className="([^"]*other-formula-dialog__actions[^"]*)"/,
    )[1];
    const matrixFooter =
      source
        .slice(source.indexOf('className="matrix-insert-dialog'))
        .match(/<footer(?: className="([^"]*)")?>/)[1] || "";
    const actions = [
      ["physics cancel", "", ["other-formula-dialog", physicsFooter]],
      ["physics insert", "", ["other-formula-dialog", physicsFooter], "disabled"],
      ["physics drawings", "primary-button", ["other-formula-dialog", physicsFooter], "disabled"],
      ["matrix cancel", "", ["matrix-insert-dialog", matrixFooter]],
      ["matrix insert", "primary-button", ["matrix-insert-dialog", matrixFooter]],
      [
        "settings reset",
        "",
        [
          "application-settings-dialog",
          "settings-workspace-content",
          "settings-compact",
          "preference-footer",
        ],
      ],
      ["settings reset disabled", "", ["settings-compact", "preference-footer"], "disabled"],
      [
        "flowchart export cancel",
        "",
        ["standard-dialog-overlay", "standard-dialog", "standard-dialog__footer"],
      ],
      [
        "flowchart export confirm",
        "primary-button",
        ["standard-dialog-overlay", "standard-dialog", "standard-dialog__footer"],
        "disabled",
      ],
      ["embedded export cancel", "geBtn", ["geDialog"]],
      ["embedded export disabled", "geBtn", ["mxWindow"], "disabled"],
    ];
    for (const [name, className, parents, attributes] of actions) {
      const target = await put(page, button(className, parents, attributes));
      assert.equal((await appearance(target)).radius, "6px", name);
    }
  } finally {
    await browser.close();
  }
});

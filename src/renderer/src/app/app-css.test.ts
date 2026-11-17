/// <reference types="node" />

import { readFileSync } from "node:fs";

test("crossfades library and editor snapshots without replaying editor layout motion", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const railCss = readFileSync(
    "src/renderer/src/patents/function-rail/function-rail-responsive.css",
    "utf8",
  );

  expect(css).toMatch(
    /html\.library-editor-view-transition::view-transition-old\(root\)[\s\S]*animation:[^;]*260ms ease-in-out/su,
  );
  expect(css).toMatch(
    /html\.library-editor-view-transition::view-transition-new\(root\)[\s\S]*animation:[^;]*260ms ease-in-out/su,
  );
  expect(css).toMatch(
    /html\.library-editor-view-transition \.patent-page-with-rail\s*\{[^}]*transition:\s*none;/su,
  );
  expect(railCss).toMatch(
    /html\.library-editor-view-transition \.patent-global-function-rail\[data-motion="enter"\]\s*\{[^}]*opacity:\s*0;[^}]*clip-path:\s*inset\(-32px -32px 100% -32px\);[^}]*transform:\s*translateY\(-8px\);[^}]*transition:\s*none;/su,
  );
  expect(railCss).toMatch(
    /html\.library-editor-function-rail-entry \.patent-global-function-rail\[data-motion="enter"\]\s*\{[^}]*animation:\s*patent-global-function-rail-enter 600ms ease-in-out both;/su,
  );
  expect(css).toMatch(
    /html\.library-editor-view-transition \.document-structure-ruler\s*\{[^}]*transform:\s*translateX\(calc\(100% \+ var\(--document-structure-ruler-gap\)\)\);[^}]*visibility:\s*hidden;[^}]*opacity:\s*0;/su,
  );
  expect(css).toMatch(
    /html\.library-editor-ruler-entry-pending \.document-structure-ruler\s*\{[^}]*transform:\s*translateX\(calc\(100% \+ var\(--document-structure-ruler-gap\)\)\);[^}]*visibility:\s*hidden;[^}]*opacity:\s*0;/su,
  );
  expect(css).not.toContain("document-structure-ruler-enter");
  expect(css).toMatch(
    /\.patent-page-with-rail:has\(\.document-structure-ruler\[data-entry-motion="true"\]\)\s*> \.patent-page-zoom-frame\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*10;/su,
  );
});

test("animates entering and leaving trash in opposite directions", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /html\.library-trash-view-transition \.app-view-transition-stage\s*\{[^}]*view-transition-name:\s*library-trash-content;/su,
  );
  expect(css).toMatch(
    /html\.library-trash-view-transition-enter::view-transition-old\(library-trash-content\)\s*\{[^}]*animation:\s*library-trash-exit-up 400ms ease-in-out both;/su,
  );
  expect(css).toMatch(
    /html\.library-trash-view-transition-enter::view-transition-new\(library-trash-content\)\s*\{[^}]*animation:\s*library-trash-enter-up 400ms ease-in-out both;/su,
  );
  expect(css).toMatch(
    /html\.library-trash-view-transition-exit::view-transition-old\(library-trash-content\)\s*\{[^}]*animation:\s*library-trash-exit-down 400ms ease-in-out both;/su,
  );
  expect(css).toMatch(
    /html\.library-trash-view-transition-exit::view-transition-new\(library-trash-content\)\s*\{[^}]*animation:\s*library-trash-enter-down 400ms ease-in-out both;/su,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*html\.library-trash-view-transition::view-transition-group\(library-trash-content\)[^{]*\{[^}]*animation:\s*none;/su,
  );
});

test("suppresses per-marker reflow transitions during workspace layout motion", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /html\.workspace-layout-view-transition \.document-structure-ruler__marker[^{]*\{[^}]*transition:\s*none;/su,
  );
  expect(css).toMatch(/html\.workspace-layout-view-transition \.patent-page-with-rail/su);
});

test("promotes only the dual panes while suppressing nested motion during a swap", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /html\.dual-pane-swap-motion \.dual-document-pane\s*\{[^}]*will-change:\s*transform;/su,
  );
  expect(css).toMatch(
    /html\.dual-pane-swap-motion \.dual-document-pane \*\s*\{[^}]*transition:\s*none !important;[^}]*animation:\s*none !important;/su,
  );
  expect(css).toMatch(
    /\.dual-pane-swap-ghost-layer\s*\{[^}]*position:\s*fixed;[^}]*overflow:\s*hidden;[^}]*pointer-events:\s*none;/su,
  );
  expect(css).toMatch(
    /\.dual-document-workspace\[data-swap-content-hidden="true"\][^{]*> \.dual-document-pane\s*\{[^}]*visibility:\s*hidden;/su,
  );
});

test("keeps nested error feedback clickable inside a modeless dialog", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  expect(css.match(/\.operation-feedback-backdrop\s*\{[^}]*\}/su)?.[0]).toMatch(
    /pointer-events:\s*auto;/u,
  );
});

test("distinguishes the active dual pane through workspace background only", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const active = css.match(/\.dual-document-pane\[data-active="true"\]\s*\{[^}]*\}/su)?.[0];
  expect(active).toContain("--document-workspace-background: #edf3fb;");
  expect(active).not.toContain("box-shadow");
  expect(css).toMatch(
    /\.editor-workspace\s*\{[^}]*background: var\(--document-workspace-background, #dfe2e7\);/su,
  );
  expect(css).not.toMatch(
    /\.dual-document-pane\[data-active="true"\] \.dual-document-pane__(?:header|title-group button)\s*\{/su,
  );
});

test("keeps drawing page edges outside the document content box", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const rule = css.match(
    /\.patent-page-with-rail > \.drawings-editor,\s*\.patent-page-with-rail > \.drawing-page,\s*\.patent-page-with-rail > \.abstract-drawing-editor\s*\{[^}]*\}/su,
  )?.[0];
  expect(rule).toMatch(/border:\s*0;/u);
  expect(rule).toMatch(/outline:\s*1px solid #d5d9e0;/u);
  expect(css).toMatch(
    /\.patent-page-with-rail > \.drawing-page\.is-file-drag-over\s*\{[^}]*outline:\s*2px dashed #2563eb;/su,
  );
});

test("aligns settings group headings with a trailing divider and left-aligned items", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const headingRule = css.match(/\.settings-workspace-navigation__group-title\s*\{[^}]*\}/su)?.[0];
  expect(headingRule).toMatch(/display:\s*flex;/u);
  expect(headingRule).toMatch(/align-items:\s*center;/u);
  expect(css).toMatch(/\.settings-workspace-navigation__group-title::after\s*\{[^}]*flex:\s*1;/su);
  expect(css).toMatch(/\.settings-workspace-navigation__item\s*\{[^}]*text-align:\s*left;/su);
});

test("allows long settings pages to scroll inside the route boundary", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const rule = css.match(
    /\.settings-workspace-content__route > div:not\(\[hidden\]\)\s*\{[^}]*\}/su,
  )?.[0];
  expect(rule).toMatch(/overflow-y:\s*auto;/u);
});

test("keeps margin settings footer inside the scrollable page width", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const rule = css.match(
    /\.page-margin-dialog--embedded \.page-margin-dialog__actions\s*\{[^}]*\}/su,
  )?.[0];
  expect(rule).toMatch(/margin:\s*0;/u);
});

test("keeps settings navigation scrollable and avoids overriding nested document paragraphs", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  expect(css).toMatch(/\.settings-workspace-navigation\s*\{[^}]*overflow-y:\s*auto;/su);
  expect(css).not.toMatch(/\.application-settings-dialog__content p\s*\{/u);
});

test("gives settings action rows spacing and storage cards internal padding", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  expect(css).toMatch(/\.data-safety-dialog__backup-actions\s*\{[^}]*gap:\s*8px;/su);
  expect(css).toMatch(/\.settings-storage-card\s*\{[^}]*padding:\s*18px;/su);
});

test("keeps issue locator labels on one line with room for cancellation", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const rule = css.match(
    /\.patent-book-tools \.reference-mark-panel__issue-locator-actions button\s*\{[^}]*\}/su,
  )?.[0];
  expect(rule).toMatch(/flex:\s*1 1 auto;/u);
  expect(rule).toMatch(/white-space:\s*nowrap;/u);
});

test("defines the shared close button baseline used by dialog headers", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /button\.dialog-close-button\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*background:\s*transparent;[^}]*border-radius:\s*50%;/su,
  );
  expect(css).toMatch(
    /button\.dialog-close-button:hover:not\(:disabled\)[^{]*\{[^}]*color:\s*#475569;[^}]*background:\s*#e2e8f0;/su,
  );
});

test("keeps shared dialog styles scoped away from professional editors", () => {
  const css = readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8");
  const selectors = [...css.matchAll(/(?:^|,)\s*(\.[^{}]+)\{/gimu)].map((match) => match[1]);

  for (const selector of selectors) {
    expect(selector).toMatch(/\.standard-dialog/u);
  }
  expect(css).not.toMatch(/chemistry|chemical|ketcher|formula(?:-figure)?/iu);
});

test("lays out the full-data transfer wizard with accessible responsive controls", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const dialogCss = readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8");

  expect(css).toMatch(
    /\.data-transfer-dialog__layout\s*\{[^}]*grid-template-columns:\s*170px minmax\(0, 1fr\);/su,
  );
  expect(dialogCss).toMatch(
    /\.standard-dialog--xl\s*\{[^}]*--standard-dialog-width:\s*1080px;[^}]*--standard-dialog-max-height:\s*720px;/su,
  );
  expect(css).toMatch(/\.data-transfer-dialog button\s*\{[^}]*min-height:\s*42px;/su);
  expect(css).toMatch(
    /\.data-transfer-dialog :focus-visible\s*\{[^}]*outline:\s*3px solid #2563eb;/su,
  );
  expect(css).toMatch(
    /@media \(max-width:\s*680px\)[^{]*\{[\s\S]*?\.data-transfer-dialog__layout\s*\{[^}]*grid-template-columns:\s*1fr;/u,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion:\s*reduce\)[^{]*\{[\s\S]*?\.data-transfer-progress__bar\s*\{[^}]*transition:\s*none;/u,
  );
});

test("uses a three-row step page with a scrollable body and a pinned action bar", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.data-transfer-step-page\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/su,
  );
  expect(css).toMatch(
    /\.data-transfer-step-page__body\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/su,
  );
  expect(css).toMatch(/\.data-transfer-wizard-actions\s*\{[^}]*border-top:/su);
  expect(css).toMatch(/\.data-transfer-wizard-actions button\s*\{[^}]*min-height:\s*42px;/su);
  expect(css).toMatch(
    /\.data-transfer-wizard-actions__group--forward\s*\{[^}]*justify-content:\s*flex-end;/su,
  );
});

test("distinguishes completed, current and upcoming steps with calm colors", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.data-transfer-dialog__steps li\[data-state="completed"\]\s*\{[^}]*color:/su,
  );
  expect(css).toMatch(
    /\.data-transfer-dialog__steps li\[data-state="current"\]\s*\{[^}]*color:\s*#1d4ed8;/su,
  );
  expect(css).toMatch(
    /\.data-transfer-dialog__steps li\[data-state="upcoming"\]\s*\{[^}]*color:/su,
  );
  expect(css).toMatch(
    /\.data-transfer-dialog__steps li\[data-state="completed"\] span\s*\{[^}]*color:/su,
  );
});

test("unifies selection, summary, notice, validation, result and locked cards", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.data-transfer-selection-card\s*\{[^}]*border-radius:\s*10px;[^}]*border:/su,
  );
  expect(css).toMatch(
    /\.data-transfer-summary-grid__card\s*\{[^}]*border-radius:\s*10px;[^}]*border:/su,
  );
  expect(css).toMatch(/\.data-transfer-notice-card\s*\{[^}]*border-radius:\s*10px;[^}]*border:/su);
  expect(css).toMatch(/\.data-transfer-card\s*\{[^}]*border-radius:\s*12px;[^}]*border:/su);
  expect(css).toMatch(/\.data-transfer-result\s*\{[^}]*border-radius:\s*12px;[^}]*border:/su);
  expect(css).toMatch(/\.data-transfer-notice-card--danger\s*\{[^}]*background:\s*#fef2f2;/su);
  expect(css).toMatch(/\.data-transfer-notice-card--warning\s*\{[^}]*background:\s*#fffbeb;/su);
  expect(css).toMatch(/\.data-transfer-card--locked\s*\{[^}]*background:\s*#f8fafc;/su);
});

test("wraps the wizard action bar on narrow windows and disables exit motion on reduced motion", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const dialogCss = readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8");

  expect(css).toMatch(
    /@media \(max-width:\s*680px\)[\s\S]*\.data-transfer-wizard-actions__row\s*\{[^}]*flex-wrap:\s*wrap;/su,
  );
  expect(dialogCss).toMatch(
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.standard-dialog-overlay,[\s\S]*\.standard-dialog\s*\{[^}]*animation:\s*none;/su,
  );
});

test("makes the draggable patent tab strip clickable while a main menu is open", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.window-shell:has\(\.menu-bar \[role="menu"\]\)\s+\.patent-tabs__top-row\s*\{[^}]*-webkit-app-region:\s*no-drag;/su,
  );
});

test("keeps the patent library primary action legible on hover and keyboard focus", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.library-header \.primary-button:hover,\s*\.library-header \.primary-button:focus-visible\s*\{[^}]*color:\s*#fff;[^}]*background:\s*#1d4ed8;[^}]*border-color:\s*#1d4ed8;[^}]*box-shadow:/su,
  );
});

test("keeps default template fields aligned with body text and preview headings at document size", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.template-catalog__token-chip\s*\{[^}]*vertical-align:\s*middle;/su);
  expect(css).toMatch(
    /\.template-catalog__paper \.ProseMirror :is\(h1, h2, h3\)\s*\{[^}]*font-size:\s*14pt !important;/su,
  );
});

test("defines shared visual tokens for application chrome and overlay layers", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const dialogCss = readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8");

  expect(css).toMatch(/:root\s*\{[^}]*--ui-color-primary:\s*#2563eb;/su);
  expect(css).toMatch(/:root\s*\{[^}]*--ui-radius-control:\s*8px;/su);
  expect(css).toMatch(/:root\s*\{[^}]*--ui-shadow-floating:/su);
  expect(css).toMatch(/:root\s*\{[^}]*--ui-layer-notice:/su);
  expect(css).toMatch(/:root\s*\{[^}]*--ui-layer-dialog:/su);
  expect(dialogCss).toMatch(/\.standard-dialog-overlay\s*\{[^}]*z-index:\s*3000;/su);
  expect(css).toMatch(/\.data-safety-guide\s*\{[^}]*z-index:\s*var\(--ui-layer-notice\);/su);
  expect(css).toMatch(/\.assistant-side-panel\s*\{[^}]*z-index:\s*var\(--ui-layer-panel\);/su);
  expect(css).toMatch(/\.custom-dual-view-dialog-backdrop\s*\{[^}]*z-index:\s*1300;/su);
});

test("uses green transient feedback and a clean red failure prompt without a tinted backdrop", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.operation-feedback\.is-success\s*\{[^}]*color:\s*#14532d;[^}]*background:\s*rgb\(255 255 255 \/ 96%\);[^}]*border-color:\s*#b8d9c3;/su,
  );
  expect(css).toMatch(
    /\.operation-feedback\.is-error\s*\{[^}]*color:\s*#25324a;[^}]*background:\s*#fff;[^}]*border-color:\s*#d7dee8;/su,
  );
  expect(css).toMatch(/\.operation-feedback-backdrop\s*\{[^}]*background:\s*transparent;/su);
  expect(css).toMatch(
    /\.operation-feedback\s*\{[^}]*top:\s*132px;[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\);/su,
  );
  expect(css).toMatch(/\.operation-feedback__success-text\s*\{[^}]*text-align:\s*center;/su);
  expect(css).toMatch(
    /\.operation-feedback__acknowledge\s*\{[^}]*min-height:\s*34px;[^}]*color:\s*#b42318;[^}]*background:\s*#fff;[^}]*border:\s*1px solid #fecaca;[^}]*border-radius:\s*6px;/su,
  );
});

test("gives the library workspace a content row when the editor toolbar is absent", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.window-shell\.is-library-active\s*\{[^}]*grid-template-rows:\s*38px calc\(30px \* var\(--settings-ui-scale, 1\)\) minmax\(0, 1fr\) 26px;/su,
  );
  expect(css).not.toMatch(
    /\.window-shell\.is-library-active\s*\{[^}]*grid-template-rows:[^;}]*\s0\s/su,
  );
});

test("aligns patent library filters and gives the type picker a focused open state", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.library-filters input,\s*\.library-filters select\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*240px;[^}]*height:\s*40px;/su,
  );
  expect(css).toMatch(
    /\.library-filter-select select\s*\{[^}]*appearance:\s*none;[^}]*padding-right:\s*52px;/su,
  );
  expect(css).toMatch(
    /\.library-filter-select::after\s*\{[^}]*right:\s*18px;[^}]*transition:\s*transform/su,
  );
  expect(css).toMatch(
    /\.library-filter-select:focus-within::after\s*\{[^}]*transform:\s*translateY\(-50%\) rotate\(180deg\);/su,
  );
  expect(css).toMatch(
    /\.library-filters input:focus,\s*\.library-filters select:focus\s*\{[^}]*background:\s*#f8fbff;[^}]*border-color:\s*#2563eb;[^}]*box-shadow:/su,
  );
});

test("uses a neutral recovery notice with clearly ranked actions", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.startup-recovery-notice\s*\{[^}]*width:\s*min\(420px,[^;]+;[^}]*border:\s*1px solid #cbd5e1;[^}]*background:\s*var\(--ui-color-surface-subtle\);/su,
  );
  expect(css).toMatch(
    /\.startup-recovery-notice__actions button\s*\{[^}]*min-height:\s*var\(--ui-control-height\);[^}]*border-radius:\s*var\(--ui-radius-control\);/su,
  );
  expect(css).toMatch(
    /\.startup-recovery-notice__actions \.primary-button\s*\{[^}]*color:\s*#fff;[^}]*background:\s*#2563eb;/su,
  );
});

test("keeps all diagram toolbar actions at the icon-only button size", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.tool-button\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/su);
  expect(css).not.toMatch(/\.tool-button\.(?:flowchart|circuit)-tool-button\s*\{/u);
});

test("keeps hidden toolbar groups hidden despite their flex and grid display rules", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.tool-bar\s*>\s*\[hidden\]\s*\{[^}]*display:\s*none;/su);
});

test("keeps both shortcut tabs left aligned and shows fixed shortcuts in two columns", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.shortcut-settings-dialog--embedded\s*\{[^}]*width:\s*100%;/su);
  expect(css).toMatch(/\.shortcut-settings-dialog--embedded\s*\{[^}]*height:\s*100%;/su);
  expect(css).toMatch(
    /\.shortcut-settings-dialog--embedded \.shortcut-settings-dialog__surface\s*\{[^}]*width:\s*100%;/su,
  );
  expect(css).toMatch(
    /\.shortcut-settings-dialog__fixed-list--dense\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/su,
  );
  expect(css).toMatch(/\.settings-workspace-content--shortcuts\s*\{[^}]*overflow:\s*hidden;/su);
  expect(css).toMatch(
    /\.shortcut-settings-dialog--embedded \.shortcut-settings-dialog__surface\s*\{[^}]*height:\s*100%;/su,
  );
  expect(css).toMatch(
    /\.shortcut-settings-dialog--embedded \.shortcut-settings-dialog__body\s*\{[^}]*overflow:\s*auto;/su,
  );
});

test("uses stacked cards and capsule switches for embedded protection settings", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.data-safety-dialog--embedded \.data-safety-dialog__grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/su,
  );
  expect(css).toMatch(/\.data-safety-dialog__switch-control\s*\{[^}]*border-radius:\s*999px;/su);
  expect(css).toMatch(
    /\.data-safety-dialog__backup-actions\s*\{[^}]*justify-content:\s*flex-end;/su,
  );
});

test("table insertion popover floats above the page without changing toolbar layout", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toContain(".insert-table-popover {");
  expect(css).toContain("position: absolute");
  expect(css).toContain(".insert-table-popover__grid {");
  expect(css).toContain("grid-template-columns: repeat(10, 18px)");
});

test("drawing sort control has a distinct button treatment in its default state", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toContain(".drawing-sort-button {");
  expect(css).toContain("background: #eff6ff");
  expect(css).toContain("border: 1px solid #93c5fd");
  expect(css).toContain(".drawing-sort-button:focus-visible {");
});

test("drawing sort mode gives visual drag feedback and respects reduced motion", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toContain(".drawing-pairs-scroll.is-sort-mode .drawing-pair-row.is-dragging {");
  expect(css).toContain(".drawing-pairs-scroll.is-sort-mode .drawing-pair-row.is-drop-target {");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
});

test("keeps the shared five-book page header outside the document body flow", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-book-page-header\s*\{[^}]*position:\s*absolute;[^}]*top:\s*max\(1mm,\s*calc\(var\(--patent-page-margin-top,\s*25\.4mm\)\s*-\s*12mm\)\);[^}]*right:\s*var\(--patent-page-margin-right,\s*31\.7mm\);[^}]*left:\s*var\(--patent-page-margin-left,\s*31\.7mm\);/su,
  );
});

test("starts the five-book editor body at the configured page margin", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).not.toMatch(
    /\.patent-book-editor-layout \.patent-prosemirror\s*\{[^}]*margin-top:\s*-/su,
  );
});

test("optically centers the library logo with its label", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.patent-tabs__brand-logo\s*\{[^}]*transform:\s*translateY\(2px\)/su);
});

test("normalizes the patent tab close button box for a centered glyph", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-tabs__close-patent\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*padding:\s*0;[^}]*line-height:\s*1;/su,
  );
});

test("integrates the dual document swap target into the left edge of the right title bar", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.dual-document-pane__header \.dual-document-pane__swap\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*left:\s*0;[^}]*width:\s*38px;[^}]*height:\s*30px;[^}]*border-right:\s*1px solid/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane__swap-icon\s*\{[^}]*width:\s*28px;[^}]*height:\s*12px;/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane\[data-pane="right"\] \.dual-document-pane__title-group\s*\{[^}]*max-width:\s*calc\(100% - 110px\);/su,
  );
  expect(css).not.toMatch(/\.dual-document-divider button\s*\{/su);
});

test("turns the dual document divider into a draggable hit strip", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.dual-document-divider\s*\{[^}]*cursor:\s*col-resize;[^}]*touch-action:\s*none;[^}]*user-select:\s*none;/su,
  );
  // 命中区是真实占据栅格列的一格（15px），不会像负偏移热区那样压住两侧面板的滚动条；
  // 视觉细线仍居中画在命中区里，指针进入整格点亮。
  expect(css).toMatch(
    /\.dual-document-divider\s*\{[^}]*width:\s*15px;[^}]*min-width:\s*15px;[^}]*background:\s*transparent;/su,
  );
  expect(css).toMatch(
    /\.dual-document-divider::after\s*\{[^}]*left:\s*50%;[^}]*width:\s*1px;[^}]*transform:\s*translateX\(-50%\);/su,
  );
  expect(css).toMatch(
    /\.dual-document-divider:hover,\s*\.dual-document-divider\[data-split-resizing="true"\]\s*\{[^}]*background:/su,
  );
  expect(css).toMatch(
    /\.dual-document-workspace\[data-split-resizing="true"\]\s*\{[^}]*cursor:\s*col-resize;[^}]*user-select:\s*none;/su,
  );
});

test("centers dual document headers and keeps split controls next to the book tabs", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.dual-document-pane__header button\s*\{[^}]*text-align:\s*center;/su);
  expect(css).toMatch(/\.menu-bar__book-navigation\s*\{[^}]*flex:\s*0 1 auto;/su);
});

test("uses the description-drawings tab width for every patent book tab", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.patent-book-tabs\s*\{[^}]*--patent-book-tab-width:\s*98px;/su);
  expect(css).toMatch(
    /\.menu-bar \.patent-book-tabs__tab,\s*\.menu-bar \.patent-book-tabs__tab-shell\s*\{[^}]*width:\s*var\(--patent-book-tab-width\);[^}]*min-width:\s*var\(--patent-book-tab-width\);/su,
  );
  expect(css).toMatch(
    /\.menu-bar \.patent-book-tabs__tab-shell \.patent-book-tabs__tab\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*center;[^}]*padding:\s*0 24px 0 10px;[^}]*white-space:\s*nowrap;/su,
  );
});

test("shrinks patent tabs evenly to a readable minimum before overflowing", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.patent-tabs__patent-list\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;/su);
  expect(css).toMatch(
    /\.patent-tabs__patent-tab-shell\s*\{[^}]*flex:\s*0 1 232px;[^}]*min-width:\s*140px;/su,
  );
});

test("fits the embedded flowchart into the main content region", () => {
  const appCss = readFileSync("src/renderer/src/app/app.css", "utf8");
  const flowchartCss = readFileSync("src/renderer/src/flowcharts/flowchart.css", "utf8");

  expect(appCss).toMatch(
    /\.window-shell\.is-flowchart-active\s*\{[^}]*grid-template-rows:\s*38px calc\(30px \* var\(--settings-ui-scale, 1\)\) minmax\(0, 1fr\);/su,
  );
  expect(appCss).toMatch(
    /\.embedded-flowchart-pane\s*(?:,[^{}]+)?\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/su,
  );
  expect(flowchartCss).toMatch(
    /\.flowchart-workspace\.is-embedded\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;/su,
  );
});

test("shows complete dual pane titles with larger controls and a compact switcher", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.dual-document-pane__header\s*\{[^}]*position:\s*relative;/su);
  expect(css).toMatch(
    /\.dual-document-pane__title-group\s*\{[^}]*position:\s*absolute;[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\)/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane__header \.dual-document-pane__close\s*\{[^}]*position:\s*absolute;[^}]*right:\s*6px;[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border-radius:\s*50%;[^}]*font-size:\s*16px;/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane__header \.dual-document-pane__switch\s*\{[^}]*width:\s*26px;[^}]*min-width:\s*26px;[^}]*font-size:\s*15px;/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane__header \.dual-document-pane__title\s*\{[^}]*overflow-x:\s*auto;[^}]*text-overflow:\s*clip;[^}]*white-space:\s*nowrap;/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane__switcher-popover\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*\d+;[^}]*top:\s*calc\(100% \+ 4px\);[^}]*left:\s*50%;[^}]*width:\s*420px;[^}]*max-width:\s*calc\(100% - 16px\);[^}]*transform:\s*translateX\(-50%\);/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane__switcher-popover\s+\.patent-book-picker\s*\{[^}]*width:\s*100%;[^}]*margin:\s*0;/su,
  );
  expect(css).not.toMatch(
    /\.dual-document-pane__header button\s*\{[^}]*(?:height|padding|overflow|background):/su,
  );
});

test("raises only an open pane switcher above the central divider controls", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.dual-document-pane__header:has\(\.dual-document-pane__switcher-popover\)\s*\{[^}]*z-index:\s*13;/su,
  );
});

test("styles custom dual-view controls, dividers, and the preset dialog", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toContain(".patent-split-controls__menu-separator {");
  expect(css).toContain(".patent-split-controls__custom-divider {");
  expect(css).toContain(".custom-dual-view-dialog__preset {");
  expect(css).toContain(".custom-dual-view-dialog__book-selects {");
  expect(css).toMatch(
    /\.custom-dual-view-dialog\s*\{[^}]*width:\s*min\(680px, 100%\);[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto auto auto;[^}]*overflow:\s*hidden;/su,
  );
  expect(css).toMatch(
    /\.custom-dual-view-dialog__presets\s*\{[^}]*gap:\s*8px;[^}]*overflow-y:\s*auto;/su,
  );
  expect(css).toMatch(
    /\.custom-dual-view-dialog__preset\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*10px 12px;/su,
  );
});

test("lets each dual document shell use the full half-screen width", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.dual-document-pane\s+\.patent-drafting-shell\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/su,
  );
});

test("constrains single-document wrappers so the editor owns vertical scrolling", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-function-rail-scope\[data-function-rail-scope="single"\]\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/su,
  );
  expect(css).toMatch(
    /\.patent-function-rail-scope\[data-function-rail-scope="single"\]\s*>\s*\[data-patent-workspace\]:not\(\[hidden\]\)\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/su,
  );
  expect(css).toMatch(
    /\.patent-function-rail-scope\[data-function-rail-scope="single"\][^{]*>\s*div:not\(\[hidden\]\)\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/su,
  );
  expect(css).toMatch(
    /\.patent-function-rail-scope\[data-function-rail-scope="single"\][^{]*>\s*\.editor-workspace\s*\{[^}]*height:\s*100%;/su,
  );
  expect(css).toMatch(
    /\.persistent-book-workspace--legacy\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/su,
  );
  expect(css).toMatch(
    /\.persistent-book-workspace--legacy\s*>\s*\.patent-book-transition-surface\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/su,
  );
  expect(css).toMatch(
    /\.persistent-book-workspace--legacy\s*>\s*\.patent-book-transition-surface\[data-active="true"\]\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/su,
  );
  expect(css).toMatch(
    /\.patent-book-transition-surface\[data-active="false"\]\s+\.document-structure-ruler\s*\{[^}]*display:\s*none;/su,
  );
  expect(css).not.toContain("document-structure-ruler-enter");
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.document-structure-ruler,\s*\.document-structure-ruler__panel,[\s\S]*?animation:\s*none;/u,
  );
});

test("keeps each dual-document function rail outside the document scroll container", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.dual-document-pane__body:has\(\.editor-workspace\)\s*\{[^}]*overflow:\s*hidden;/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane\s+\.patent-function-rail-scope:has\(>\s*\.editor-workspace\)\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/su,
  );
  expect(css).toMatch(
    /\.dual-document-pane\s+\.patent-function-rail-scope\s*>\s*\.editor-workspace\s*\{[^}]*height:\s*100%;/su,
  );
});

test("uses one fixed-width collapsible function rail without legacy dual-document sizing", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-page-with-rail\s*\{[^}]*--patent-function-rail-width:\s*280px;[^}]*--patent-function-rail-collapsed-width:\s*36px;[^}]*--patent-function-rail-gap:\s*12px;/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail-slot\s*\{[^}]*grid-column:\s*3;[^}]*width:\s*0;[^}]*margin-left:\s*var\(--patent-function-rail-gap\);[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*8;/su,
  );
  expect(css).toMatch(
    /\.patent-page-with-rail:not\(\[data-pane-rail-space="constrained"\]\):has\(\s*> \.patent-global-function-rail-slot\[data-layout="docked"\]\s*\)\s*\{[^}]*--patent-function-rail-reserved-width:\s*calc\(\s*var\(--patent-function-rail-width\)\s*\+\s*var\(--patent-function-rail-gap\)\s*\);/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail-slot\[data-layout="docked"\]\[data-expanded="true"\]\s*\{[^}]*width:\s*var\(--patent-function-rail-width\);/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail-slot\[data-layout="docked"\]\[data-expanded="false"\]\s*\{[^}]*width:\s*var\(--patent-function-rail-collapsed-width\);/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail-slot\[data-layout="docked"\] \.patent-global-function-rail\s*\{[^}]*position:\s*relative;[^}]*width:\s*var\(--patent-function-rail-width\)/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail-slot\[data-layout="overlay"\] \.patent-global-function-rail\s*\{[^}]*position:\s*absolute;[^}]*width:\s*var\(--patent-function-rail-width\)/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__collapsed-toggle\s*\{[^}]*width:\s*var\(--patent-function-rail-collapsed-width\);[^}]*min-width:\s*var\(--patent-function-rail-collapsed-width\);[^}]*writing-mode:\s*vertical-rl/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-width:\s*none;[^}]*transition:[^}]*transform\s+400ms ease-in-out[^}]*opacity\s+400ms ease-in-out/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail::-webkit-scrollbar\s*\{[^}]*display:\s*none;/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__collapsed-toggle\s*\{[^}]*transition:[^}]*transform\s+150ms[^}]*opacity\s+150ms/su,
  );
  expect(css).toMatch(
    /@starting-style\s*\{[\s\S]*?\.patent-global-function-rail-slot:not\(\[data-book-kind="description-drawings"\]\):not\(\s*\[data-book-kind="abstract-drawing"\]\s*\)\s+\.patent-global-function-rail__collapsed-toggle\s*\{/su,
  );
  expect(css).not.toMatch(
    /@starting-style\s*\{[\s\S]*?\.patent-global-function-rail-slot:not\(\[data-book-kind="description-drawings"\]\):not\(\s*\[data-book-kind="abstract-drawing"\]\s*\)\s+\.patent-global-function-rail,/su,
  );
  expect(css).not.toContain("--dual-function-rail-width");
});

test("keeps compact and navigating rulers outside one stable description page position", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-page-with-rail\s*\{[^}]*--document-structure-ruler-wide-width:\s*76px;[^}]*--document-structure-ruler-compact-width:\s*20px;[^}]*--document-structure-ruler-gap:\s*8px;[^}]*--document-structure-ruler-reserved-width:\s*0px;[^}]*--document-structure-ruler-slot-width:\s*0px;/su,
  );
  expect(css).toMatch(
    /\.patent-page-with-rail\[data-structure-ruler="true"\]\s*\{[^}]*--document-structure-ruler-slot-width:\s*var\(--document-structure-ruler-compact-width\);[^}]*--document-structure-ruler-reserved-width:\s*calc\(\s*var\(--document-structure-ruler-wide-width\)\s*\+\s*var\(--document-structure-ruler-gap\)\s*\);/su,
  );
  expect(css).toMatch(
    /\.patent-page-with-rail\[data-structure-ruler-offset="true"\]\s*\{[^}]*--document-structure-ruler-slot-width:\s*var\(--document-structure-ruler-wide-width\);[^}]*--document-structure-ruler-reserved-width:\s*calc\(\s*var\(--document-structure-ruler-wide-width\)\s*\+\s*var\(--document-structure-ruler-gap\)\s*\);/su,
  );
  expect(css).toMatch(
    /\.patent-page-with-rail\[data-structure-ruler="true"\]:not\(\[data-pane-ruler-compact="true"\]\):has\(\s*> \.document-structure-ruler\[data-mode="wide"\],[^{}]*\)\s*\{[^}]*--document-structure-ruler-slot-width:\s*var\(--document-structure-ruler-wide-width\);[^}]*--document-structure-ruler-reserved-width:\s*calc\(\s*var\(--document-structure-ruler-wide-width\)\s*\+\s*var\(--document-structure-ruler-gap\)\s*\);/su,
  );
  expect(css).toMatch(
    /\.patent-page-with-rail\s*\{[^}]*grid-template-columns:\s*var\(--document-structure-ruler-reserved-width\)\s+calc\(var\(--patent-book-page-width\) \* var\(--patent-page-zoom\)\)\s+var\(--patent-function-rail-reserved-width\);/su,
  );
  expect(css).toMatch(/\.patent-page-zoom-frame\s*\{[^}]*grid-column:\s*2;/su);
  expect(css).toMatch(
    /\.patent-page-with-rail > \.drawings-editor,\s*\.patent-page-with-rail > \.drawing-page,\s*\.patent-page-with-rail > \.abstract-drawing-editor\s*\{[^}]*grid-column:\s*2;[^}]*width:\s*var\(--patent-book-page-width\);/su,
  );
  expect(css).not.toMatch(
    /\.document-structure-ruler\[data-mode="compact"\]:is\(:hover, :focus-within\)\s+\.document-structure-ruler__panel\s*\{[^}]*width:\s*var\(--document-structure-ruler-wide-width\);/su,
  );
  expect(css).toMatch(/\.document-structure-ruler\s*\{[^}]*justify-self:\s*end;/su);
  expect(css).toMatch(/\.document-structure-ruler__panel\s*\{[^}]*right:\s*0;[^}]*left:\s*auto;/su);
});

test("uses the function-rail corner radius on every patent editing page", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.patent-global-function-rail\s*\{[^}]*border-radius:\s*12px;/su);
  expect(css).toMatch(
    /\.patent-book-editor-layout \.patent-book-rich-text\s*\{[^}]*border-radius:\s*var\(--ui-radius-window, 12px\);/su,
  );
  expect(css).toMatch(/\.drawing-page\s*\{[^}]*border-radius:\s*12px;/su);
  expect(css).toMatch(
    /\.patent-book-editor,\s*\.claims-editor,\s*\.abstract-editor,\s*\.drawings-editor,\s*\.abstract-drawing-editor\s*\{[^}]*border-radius:\s*var\(--ui-radius-window, 12px\);/su,
  );
});

test("styles the structure ruler as a lightweight text track with compact ticks", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.document-structure-ruler__panel\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler__label--wide\s*\{[^}]*height:\s*22px;[^}]*border-radius:\s*5px;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-mode="compact"\]\s+\.document-structure-ruler__marker::after\s*\{[^}]*width:\s*5px;[^}]*height:\s*5px;[^}]*border-radius:\s*999px;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-mode="compact"\]\s+\.document-structure-ruler__marker\[data-active="true"\]::after\s*\{[^}]*width:\s*12px;[^}]*background:\s*#3b82f6;/su,
  );
  expect(css).toMatch(/\.document-structure-ruler__label--compact\s*\{[^}]*display:\s*none;/su);
  expect(css).not.toMatch(
    /\.document-structure-ruler__marker(?:\[[^\]]+\]|:[^{,\s]+)?[^{]*\{[^}]*background:\s*rgb\(219 234 254 \/ 88%\)/su,
  );
});

test("contracts structure markers without drawing a navigation container", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.document-structure-ruler\[data-navigation="true"\]\s+\.document-structure-ruler__panel\s*\{[^}]*--ruler-navigation-offset:\s*0px;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-mode="compact"\]\[data-navigation="true"\]\s+\.document-structure-ruler__panel\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*backdrop-filter:\s*none;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler__marker\s*\{[^}]*transition:[^}]*transform\s+400ms ease-in-out[^}]*height\s+400ms ease-in-out/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-navigation="true"\]\s+\.document-structure-ruler__marker\s*\{[^}]*transform:\s*translateY\(calc\(var\(--ruler-navigation-shift-y\) - var\(--ruler-navigation-offset\)\)\);/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-navigation="true"\]\s+\.document-structure-ruler__panel\[data-wheel-active="true"\]\s+\.document-structure-ruler__marker\s*\{[^}]*transition-duration:\s*90ms;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-scroll-active="true"\]\s+\.document-structure-ruler__marker\s*\{[^}]*transition:\s*none;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-navigation="true"\][^{]*\.document-structure-ruler__marker\[data-center="true"\][^{]*\.document-structure-ruler__label--wide\s*\{[^}]*background:\s*rgb\(219 234 254 \/ 78%\);/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-mode="compact"\]\[data-navigation="true"\][\s\S]*\.document-structure-ruler__marker::after\s*\{[^}]*display:\s*none;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-mode="compact"\]\[data-navigation="true"\][\s\S]*\.document-structure-ruler__label--wide\s*\{[^}]*display:\s*flex;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-navigation="true"\]\s+\.document-structure-ruler__marker::after\s*\{[^}]*display:\s*none;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-navigation="true"\]\s+\.document-structure-ruler__label--wide\s*\{[^}]*display:\s*flex;/su,
  );
});

test("uses a transient first-line flash and disables ruler motion when requested", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.document-structure-ruler-target-flash::first-line\s*\{[^}]*background-color:\s*rgb\(219 234 254 \/ 58%\);/su,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.document-structure-ruler__marker[^}]*transition:\s*none;/su,
  );
  expect(css).not.toContain(".document-structure-ruler-target-highlight");
});

test("does not draw a vertical range line beside structure ruler markers", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).not.toMatch(
    /\.document-structure-ruler__marker[^{]*\{[^}]*border-left(?:-color)?:/su,
  );
});

test("right-aligns description paragraph numbers in the structure ruler", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.document-structure-ruler__marker\[data-kind="description-paragraph"\]\s+\.document-structure-ruler__label--wide\s*\{[^}]*justify-content:\s*flex-end;/su,
  );
});

test("centers drawing figure numbers in the structure ruler", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.document-structure-ruler__marker\[data-kind="drawing-figure"\]\s+\.document-structure-ruler__label--wide\s*\{[^}]*justify-content:\s*center;/su,
  );
});

test("styles structure errors as short labels with a complete floating label", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.document-structure-ruler__label--full\s*\{[^}]*color:\s*#dc2626;/su);
  expect(css).toMatch(
    /\.document-structure-ruler__marker\[data-error="true"\][^{]*\.document-structure-ruler__label--wide\s*\{[^}]*color:\s*#dc2626;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler\[data-mode="compact"\]\s+\.document-structure-ruler__marker\[data-error="true"\]::after\s*\{[^}]*background:\s*#dc2626;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler__label--full\s*\{[^}]*display:\s*none;[^}]*width:\s*max-content;[^}]*max-width:\s*240px;[^}]*overflow:\s*visible;[^}]*box-shadow:/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler__marker\[data-error="true"\]:is\(\s*:hover,\s*:focus-visible,\s*\[data-active="true"\]\s*\)[^{]*\.document-structure-ruler__label--full\s*\{[^}]*display:\s*flex;/su,
  );
  expect(css).toMatch(/\.document-structure-ruler__panel\s*\{[^}]*overflow:\s*visible;/su);
  expect(css).not.toContain(".document-structure-ruler__summary");
  expect(css).not.toContain(".document-structure-ruler__issues");
});

test("pins the collapsed function rail to each scope edge and opens the overlay to the left", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-function-rail-edge-host\s*\{[^}]*--patent-function-rail-gap:\s*12px;[^}]*position:\s*sticky;[^}]*left:\s*0;[^}]*top:\s*0;[^}]*width:\s*100%;[^}]*justify-content:\s*flex-end;[^}]*pointer-events:\s*none;/su,
  );
  expect(css).toMatch(
    /\.patent-function-rail-edge-host\s*>\s*\.patent-global-function-rail-slot\s*\{[^}]*width:\s*var\(--patent-function-rail-collapsed-width\);[^}]*margin-left:\s*0;[^}]*pointer-events:\s*auto;/su,
  );
  expect(css).toMatch(
    /\.patent-function-rail-edge-host[^{]*\.patent-global-function-rail\s*\{[^}]*right:\s*calc\(var\(--patent-function-rail-collapsed-width\) \+ var\(--patent-function-rail-gap\)\);[^}]*transform-origin:\s*top right;/su,
  );
});

test("uses shared close controls for overlay rail header actions", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const sharedCss = readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8");
  const rail = readFileSync("src/renderer/src/patents/patent-global-function-rail.tsx", "utf8");

  expect(rail).toContain(
    "patent-global-function-rail__header-action dialog-close-button dialog-close-control",
  );
  expect(sharedCss).toMatch(
    /button\.dialog-close-button\.dialog-close-control\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border-radius:\s*6px;/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__header-action\.dialog-close-control\[aria-pressed="true"\]:hover\s*\{[^}]*background:\s*var\(--editor-display-panel-selected, #bfdbfe\);/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__header-action\.dialog-close-control\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--editor-display-panel-accent, #2563eb\);[^}]*background:\s*var\(--editor-display-panel-surface, #dbeafe\);/su,
  );
});

test("disables function rail transitions when reduced motion is requested", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.patent-global-function-rail[^}]*transition:\s*none/su,
  );
});

test("styles draft model discovery as a compact secondary action", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.ai-model-discovery-row\s*\{[^}]*display:\s*flex;[^}]*margin:\s*12px 20px 0;/su,
  );
  expect(css).toMatch(
    /\.ai-model-discovery-row button\s*\{[^}]*border-radius:\s*9px;[^}]*color:\s*#3565ca;/su,
  );
});

test("gives AI model settings buttons a coordinated business hierarchy", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.ai-model-manager__section-heading\s*>\s*button,\s*\.ai-model-card__actions button,\s*\.ai-provider-endpoint button,\s*\.ai-model-discovery-row button,\s*\.ai-model-manager\s*>\s*footer button,\s*\.ai-model-editor\s*>\s*footer button\s*\{[^}]*min-height:\s*34px;[^}]*border-radius:\s*10px;[^}]*font-weight:\s*600;[^}]*transition:/su,
  );
  expect(css).toMatch(
    /\.ai-model-manager \.is-primary\s*\{[^}]*color:\s*#fff;[^}]*border-color:\s*#2f63ca;[^}]*background:\s*linear-gradient\(180deg, #3f78e3, #2f63ca\);[^}]*box-shadow:/su,
  );
  expect(css).toMatch(
    /\.ai-model-manager\s*>\s*footer button:not\(\.is-primary\),\s*\.ai-model-editor\s*>\s*footer button:not\(\.is-primary\)\s*\{[^}]*color:\s*#526077;[^}]*border-color:\s*#cdd8e7;[^}]*background:\s*#fff;/su,
  );
  expect(css).toMatch(
    /\.ai-provider-endpoint button\s*\{[^}]*min-height:\s*28px;[^}]*border:\s*1px solid #cfddf4;[^}]*border-radius:\s*999px;[^}]*background:\s*#eef4ff;/su,
  );
  expect(css).toMatch(
    /\.ai-model-card__actions \.is-danger:hover:not\(:disabled\)\s*\{[^}]*color:\s*#b43b4b;[^}]*background:\s*#fff0f2;/su,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ai-model-manager button,\s*\.ai-model-editor button\s*\{[^}]*transition:\s*none;/su,
  );
});

test("keeps AI model editor field text padded and distinguishes placeholders", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.ai-model-editor \.ai-model-field input,\s*\.ai-model-editor \.ai-model-field select,\s*\.ai-model-editor \.ai-settings-grid input,\s*\.ai-model-editor \.ai-settings-grid select\s*\{[^}]*padding-inline:\s*12px;[^}]*color:\s*#1f2937;/su,
  );
  expect(css).toMatch(
    /\.ai-model-editor \.ai-model-field input::placeholder,\s*\.ai-model-editor \.ai-settings-grid input::placeholder\s*\{[^}]*color:\s*#94a3b8;[^}]*opacity:\s*1;/su,
  );
  expect(css).toMatch(
    /\.ai-model-editor \.ai-model-field select option,\s*\.ai-model-editor \.ai-settings-grid select option\s*\{[^}]*color:\s*#1f2937;/su,
  );
});

test("keeps embedded AI model profiles as spacious standalone cards", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.ai-model-list\s*\{[^}]*gap:\s*10px;[^}]*margin:\s*0 22px;/su);
  expect(css).toMatch(
    /\.ai-model-card\s*\{[^}]*padding:\s*14px;[^}]*border:\s*1px solid #e0e6ef;[^}]*border-radius:\s*13px;[^}]*box-shadow:\s*0 4px 16px/su,
  );
  expect(css).not.toMatch(
    /\.ai-model-manager--embedded \.ai-model-list\s*\{[^}]*margin-top:\s*-1px;/su,
  );
  expect(css).not.toMatch(
    /\.ai-model-manager--embedded \.ai-model-card\s*\{[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/su,
  );
});

test("aligns the AI correction panel with the document page below the toolbar", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.assistant-side-panel\s*\{[^}]*top:\s*var\(--assistant-panel-top, 132px\);[^}]*right:\s*24px;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*width:\s*min\(399px, calc\(100vw - 48px\)\);[^}]*overflow:\s*hidden;[^}]*border-radius:\s*var\(--ui-radius-card\);/su,
  );
  expect(css).toMatch(/\.assistant-side-panel\[hidden\]\s*\{[^}]*display:\s*none;/su);
  expect(css).not.toMatch(/\.ai-thinking-option\s*\{/u);
  expect(css).not.toMatch(/\.ai-switch\s*\{/u);
  expect(css).not.toMatch(/\.ai-toggle\s*\{/u);
  expect(css).toMatch(
    /\.assistant-side-panel__header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;[^}]*flex:\s*0 0 auto;/su,
  );
  expect(css).toMatch(
    /\.ai-icon-button\s*\{[^}]*display:\s*inline-grid;[^}]*place-items:\s*center;[^}]*line-height:\s*1;/su,
  );
  expect(css).toMatch(
    /\.patent-check-panel button\.ai-icon-button:not\(\.dialog-close-button\)\s*\{[^}]*padding:\s*0;/su,
  );
  expect(css).toMatch(
    /\.patent-check-panel \.patent-check-panel__filters button\s*\{[^}]*border:\s*0;[^}]*border-bottom:\s*2px solid transparent;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/su,
  );
  expect(css).toMatch(
    /\.patent-check-panel__filters button\[aria-selected="true"\]\s*\{[^}]*border-bottom-color:\s*#3d8a63;[^}]*background:\s*transparent;/su,
  );
  expect(css).toMatch(
    /\.patent-check-panel button\.patent-check-panel__recheck\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*104px;[^}]*justify-self:\s*center;/su,
  );
  expect(css).toMatch(
    /\.assistant-side-panel__body\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/su,
  );
  expect(css).toMatch(
    /\.ai-correction-running\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/su,
  );
  expect(css).toMatch(/\.ai-scope-options label\.is-selected\s*\{[^}]*background:\s*#e7f0ff;/su);
  expect(css).toMatch(
    /\.ai-thinking-stream\.is-expanded\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;[^}]*flex-direction:\s*column;/su,
  );
  expect(css).toMatch(
    /\.ai-thinking-stream__content\s*\{[^}]*min-height:\s*min\(320px, 45vh\);[^}]*flex:\s*1 1 auto;[^}]*height:\s*auto;/su,
  );
  expect(css).toMatch(
    /\.ai-stop-action\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;[^}]*width:\s*100%;/su,
  );
});

test("styles bounded AI correction results and non-replacement compliance anchors", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.ai-result-limit-notice\s*\{[^}]*border:\s*1px solid #f0d9a8;[^}]*background:\s*#fff9ec;/su,
  );
  expect(css).toMatch(
    /\.ai-issue-anchor-text\s*\{[^}]*border-left:\s*3px solid var\(--editor-display-panel-line, #8da8db\);[^}]*background:\s*var\(--editor-display-panel-surface, #f5f8fd\);/su,
  );
});

test("renders the toolbar assistant wordmark with a colorful gradient", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.xiaozhan-ai-tool-icon\s*\{[^}]*background:\s*linear-gradient\([^}]*background-clip:\s*text;[^}]*color:\s*transparent;[^}]*font-weight:\s*800;/su,
  );
});

test("gives text polish a balanced requirement row and a large scrollable result", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.text-polish-requirement textarea\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*112px;/su,
  );
  expect(css).toMatch(/\.text-polish-presets__options\s*\{[^}]*flex-wrap:\s*wrap;/su);
  expect(css).toMatch(
    /\.text-polish-result pre\s*\{[^}]*min-height:\s*260px;[^}]*overflow:\s*auto;/su,
  );
  expect(css).toMatch(
    /\.text-polish-result footer\s*\{[^}]*grid-template-columns:\s*1fr 1\.35fr;/su,
  );
  expect(css).toMatch(
    /\.text-polish-conversation \.ai-thinking-stream__content pre\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/su,
  );
  expect(css).toMatch(
    /\.text-polish-conversation__messages\s*\{[^}]*flex:\s*1 1 240px;[^}]*min-height:\s*220px;/su,
  );
  expect(css).toMatch(
    /\.text-polish-conversation__actions \.ai-secondary-action\s*\{[^}]*min-width:\s*88px;[^}]*white-space:\s*nowrap;/su,
  );
});

test("keeps quick-check copy neutral while using green accents and severity colors", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-check-panel\s*\{[^}]*--assistant-panel-color:\s*var\(--editor-display-panel-ink, #1f2937\);[^}]*--assistant-panel-heading:\s*var\(--editor-display-panel-ink, #172033\);/su,
  );
  expect(css).toMatch(/\.quick-check-tool-icon\s*\{[^}]*color:\s*#27845a;/su);
  expect(css).toMatch(
    /\.patent-check-panel li\[data-severity="error"\][^{]*\{[^}]*border-left-color:\s*#d92d20;/su,
  );
  expect(css).toMatch(
    /\.patent-check-panel li\[data-severity="warning"\][^{]*\{[^}]*border-left-color:\s*#dc6803;/su,
  );
  expect(css).toMatch(
    /\.patent-check-panel li\[data-severity="suggestion"\][^{]*\{[^}]*border-left-color:\s*#1570ef;/su,
  );
  expect(css).toMatch(
    /\.patent-check-panel__issue-title\s*\{[^}]*color:\s*var\(--editor-display-panel-ink, #111827\);[^}]*font-weight:\s*700;/su,
  );
});

test("animates modal backdrops and surfaces while respecting reduced motion", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toContain("@keyframes dialog-backdrop-enter");
  expect(css).toContain("@keyframes dialog-surface-enter");
  expect(css).toContain("@keyframes dialog-surface-exit");
  expect(css).toMatch(
    /\.dialog-backdrop\s*\{[^}]*animation:\s*dialog-backdrop-enter var\(--ui-motion-spatial\)/su,
  );
  expect(css).toMatch(
    /\.dialog-backdrop\s*>\s*\[role="dialog"\][^{]*\{[^}]*animation:\s*dialog-surface-enter var\(--ui-motion-spatial\)/su,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dialog-backdrop[^{]*\{[^}]*animation:\s*none/su,
  );
  expect(css).toMatch(
    /\.motion-presence\[data-motion-state="closing"\][^{]*\.dialog-backdrop\s*\{[^}]*animation:\s*dialog-backdrop-exit var\(--ui-motion-spatial\)/su,
  );
});

test("keeps the DOCX preview below critical application errors", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.docx-import-backdrop\s*\{[^}]*z-index:\s*var\(--ui-layer-dialog\);/su);
  expect(css).toMatch(
    /\.docx-import-dialog__footer \.primary-button:disabled\s*\{[^}]*cursor:\s*not-allowed;[^}]*background:\s*#e2e8f0;/su,
  );
  expect(css).toMatch(
    /\.application-error-backdrop\s*\{[^}]*z-index:\s*var\(--ui-layer-critical\);/su,
  );
});

test("styles the collapsed function rail as a neutral edge handle", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-global-function-rail__collapsed-toggle\s*\{[^}]*width:\s*var\(--patent-function-rail-collapsed-width\);[^}]*height:\s*128px;[^}]*min-height:\s*128px;[^}]*background:\s*var\(--editor-display-panel, #f8fafc\);[^}]*border:\s*1px solid var\(--editor-display-panel-line, #cbd5e1\);[^}]*border-right:\s*0;[^}]*border-radius:\s*9px 0 0 9px;/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__collapsed-toggle:hover[^}]*\{[^}]*color:\s*var\(--editor-display-panel-accent, #1d4ed8\);[^}]*background:\s*var\(--editor-display-panel-surface, #eff6ff\);[^}]*transform:\s*translateX\(-1px\);/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__collapsed-toggle::before\s*\{[^}]*width:\s*3px;[^}]*height:\s*32px;[^}]*background:\s*var\(--editor-display-panel-surface, #d7dee8\);/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__collapsed-toggle\s*>\s*span:first-child\s*\{[^}]*display:\s*none;/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__collapsed-toggle\s*>\s*span:last-child\s*\{[^}]*font-size:\s*12px;[^}]*font-weight:\s*600;[^}]*letter-spacing:\s*2px;/su,
  );
});

test("does not snapshot editor pages while switching patent books", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).not.toMatch(/view-transition-name:\s*patent-function-rail;/u);
  expect(css).not.toMatch(/::view-transition-group\(patent-function-rail\)/u);
  expect(css).not.toMatch(/view-transition-name:\s*patent-book-content;/u);
  expect(css).not.toMatch(/::view-transition-(?:group|old|new)\(patent-book-content\)/u);
  expect(css).not.toMatch(/@keyframes\s+patent-book-content-(?:in|out)/u);
});

test("shows transparent description drawings on white paper without a tinted preview background", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.drawing-figure-frame\s*\{[^}]*background:\s*#fff;/su);
  expect(css).toMatch(
    /(?:^|\n)\.drawing-figure-card\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/su,
  );
});

test("lets the normal description drawing page grow while keeping sort mode bounded", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.drawing-workbench-body\s*\{[^}]*align-items:\s*start;/su);
  expect(css).not.toMatch(
    /\.drawing-page\s*\{[^}]*(?:\{|;)\s*height:\s*var\(--patent-book-page-min-height\);/su,
  );
  expect(css).toMatch(/\.drawing-pairs-scroll\s*\{[^}]*overflow:\s*visible;/su);
  expect(css).toMatch(
    /\.drawing-page\.is-sort-mode\s*\{[^}]*height:\s*var\(--patent-book-page-min-height\);/su,
  );
  expect(css).toMatch(/\.drawing-pairs-scroll\.is-sort-mode\s*\{[^}]*overflow:\s*auto;/su);
});

test("keeps drawing explanations as clear labels above comfortably sized inputs", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.drawing-explanation-card\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto auto;[^}]*background:\s*transparent;[^}]*border:\s*0;/su,
  );
  expect(css).toMatch(
    /\.drawing-explanation-card header\s*\{[^}]*min-height:\s*20px;[^}]*margin:\s*0;/su,
  );
  expect(css).toMatch(
    /\.drawing-explanation-card textarea,[^{]*\{[^}]*display:\s*block;[^}]*min-height:\s*72px;[^}]*overflow:\s*hidden;/su,
  );
  expect(css).toMatch(
    /\.drawing-explanation-rail\s*\{[^}]*display:\s*grid;[^}]*gap:\s*12px;[^}]*padding:\s*12px;/su,
  );
  expect(css).not.toMatch(/\.drawing-explanation-scroll\s*\{/u);
});

test("keeps unselected drawing figures borderless and shows the selection border on the image frame", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const editorCss = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  // No solid frame around the image in the abstract/description drawing editors.
  expect(css).toMatch(/\.drawing-figure-placeholder\s*\{[^}]*border:\s*none;/su);
  expect(css).toMatch(/\.drawing-figure-frame\s*\{[^}]*border:\s*none;/su);
  // No dashed outer frame around the figure card or row, and no dashed
  // separator between adjacent figure rows.
  expect(css).toMatch(/\.drawing-figure-row\s*\{[^}]*border:\s*none;/su);
  expect(css).toMatch(/\.drawing-figure-card\s*\{[^}]*border:\s*1px solid transparent;/su);
  expect(css).toMatch(/\.drawing-pair-row\s*\{[^}]*border-bottom:\s*0;/su);
  // The shared selection outline wraps the image frame tightly (not the whole
  // card, so the 图N label stays outside) in normal mode, while sort mode shows
  // a dashed card frame on every figure and only turns it solid for the
  // selected figure and the drop target.
  expect(editorCss).toMatch(
    /\.image-selection-frame\.is-selected\s*\{[^}]*outline:\s*2px solid #2563eb;[^}]*outline-offset:\s*3px;/su,
  );
  expect(css).toMatch(
    /\.drawing-pairs-scroll\.is-sort-mode \.drawing-figure-card\s*\{[^}]*border:\s*1px dashed #cbd5e1;/su,
  );
  expect(css).toMatch(
    /\.drawing-pairs-scroll\.is-sort-mode \.drawing-figure-card\.is-selected\s*\{[^}]*border:\s*1px solid #2563eb;/su,
  );
  expect(css).toMatch(
    /\.drawing-pairs-scroll\.is-sort-mode \.drawing-pair-row\.is-drop-target \.drawing-figure-card\s*\{[^}]*border:\s*1px solid #2563eb;/su,
  );
  // The per-figure delete button stays compact and centers its × glyph.
  expect(css).toMatch(
    /\.drawing-delete-button\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*width:\s*20px;[^}]*height:\s*20px;/su,
  );
});

test("keeps image setting actions readable in the narrow function rail", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.figure-rail-panel__actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/su,
  );
  expect(css).toMatch(/\.figure-rail-panel__actions button\s*\{[^}]*white-space:\s*nowrap;/su);
});
test("Word-style text selection gutter uses a right-pointing cursor", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const rule = css.match(/\.patent-text-selection-gutter\s*\{[^}]*\}/u)?.[0] ?? "";
  const cursor = readFileSync("src/renderer/src/assets/selection-gutter-cursor.png");
  const license = readFileSync(
    "src/renderer/src/assets/selection-gutter-cursor.LICENSE.txt",
    "utf8",
  );

  expect(rule).toContain("top: 0;");
  expect(rule).toContain("left: 0;");
  expect(rule).toContain("width: calc(var(--patent-page-margin-left, 31.7mm) - 18px);");
  expect(rule).toContain("cursor:");
  expect(rule).toContain('url("../assets/selection-gutter-cursor.png") 12 1');
  expect(cursor.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(cursor.readUInt32BE(16)).toBe(16);
  expect(cursor.readUInt32BE(20)).toBe(16);
  expect(license).toContain("xbitmaps 1.1.3");
  expect(license).toContain("Copyright (c) 1998 The Open Group");
});

test("styles the welcome full-data recovery entry as a distinct full-width action", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.welcome-dialog__restore\s*\{[^}]*width:\s*100%;[^}]*border:[^}]*border-radius:/su,
  );
  expect(css).toMatch(
    /\.welcome-dialog__restore:hover:not\(:disabled\),\s*\.welcome-dialog__restore:focus-visible\s*\{/su,
  );
  expect(css).toMatch(/\.welcome-dialog__restore:disabled\s*\{[^}]*cursor:\s*not-allowed;/su);
});

test("removes the welcome dialog's separate legacy close control", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).not.toMatch(/\.welcome-dialog__dismiss(?:\s|:|\{)/u);
});

test("uses a text cursor on the passive workspace and right paper margin", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-editor-workspace\[data-patent-text-projection\]\s*\{[^}]*cursor:\s*text;/su,
  );
  expect(css).toMatch(
    /\.document-structure-ruler,\s*\.patent-global-function-rail-slot\s*\{[^}]*cursor:\s*default;/su,
  );
});

test("uses a calm non-flashing highlight for a restored patent card", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toContain(".library-card.is-snapshot-restore-highlight");
  expect(css).toContain("border-color: #2563eb");
  expect(css).not.toMatch(/is-snapshot-restore-highlight[^}]*animation:/su);
});

test("falls a saved double-column patent library back to one column in a narrow container", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.library-view\s*\{[^}]*container-type:\s*inline-size;/su);
  expect(css).toMatch(
    /@container\s*\(max-width:\s*899px\)\s*\{[\s\S]*\.patent-library-month-cards\[data-view-mode="double"\]\s*\{[^}]*grid-template-columns:\s*1fr;/su,
  );
});

test("reserves the library scrollbar gutter without shrinking cards when it appears", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.library-view\s*\{[^}]*scrollbar-gutter:\s*stable;/su);
});

test("pins the patent library header and filters and scrolls only the list", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  // 标题、按钮、搜索栏整块吸顶，只有下方专利列表滚动。
  expect(css).toMatch(
    /\.library-toolbar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*background:\s*#fff;/su,
  );
  // 顶部留白交给工具条自己，否则吸顶后标题会贴住窗口上沿。
  expect(css).toMatch(/\.library-view\s*\{[^}]*padding:\s*0 max\([^}]*\) 28px;/su);
  // 与列表的间距由工具条承担，吸顶底色才能盖住这段空隙。
  expect(css).toMatch(/\.library-filters\s*\{[^}]*margin-bottom:\s*0;/su);
  // 文档库 / 回收站没有工具条，页头自己保留 28px 顶部间距。
  expect(css).toMatch(/\.library-view > \.library-header\s*\{[^}]*padding-top:\s*28px;/su);
});

test("gives the patent library view and month controls clear compact states", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-library-view-toggle\s*\{[^}]*min-height:\s*34px;[^}]*padding:\s*2px;[^}]*border:\s*1px solid #d7dee8;[^}]*border-radius:\s*8px;[^}]*background:\s*#f8fafc;/su,
  );
  expect(css).toMatch(
    /\.patent-library-view-toggle button\[aria-pressed="true"\]\s*\{[^}]*background:\s*#fff;[^}]*border:\s*1px solid #bfdbfe;[^}]*box-shadow:\s*0 1px 2px rgb\(37 99 235 \/ 16%\);/su,
  );
  expect(css).toMatch(
    /\.patent-library-view-toggle button:hover:not\(:disabled\)\s*\{[^}]*background:\s*#eaf2fd;/su,
  );
  expect(css).toMatch(
    /\.patent-library-month-heading\s*\{[^}]*min-height:\s*38px;[^}]*padding:\s*0 8px;/su,
  );
  expect(css).toMatch(
    /\.patent-library-month-chevron\s*\{[^}]*justify-self:\s*end;[^}]*display:\s*grid;/su,
  );
});

test("keeps illustrated patent titles and customer names reserved above the flexible abstract", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-illustrated-card__body\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(2\.8em, auto\) auto minmax\(0, 1fr\);/su,
  );
  expect(css).toMatch(/\.patent-illustrated-card__title-row\s*\{[^}]*min-height:\s*2\.8em;/su);
  expect(css).toMatch(
    /\.patent-illustrated-card__customer\s*\{[^}]*min-height:\s*1\.5em;[^}]*flex-shrink:\s*0;/su,
  );
  expect(css).toMatch(
    /\.patent-illustrated-card__abstract-hover\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*visible;/su,
  );
});

test("uses regular-weight text for the patent library new-patent button", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.library-header \.primary-button\s*\{[^}]*font-weight:\s*400;/su);
});

test("uses regular-weight text for the create-patent dialog submit button", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-dialog \.dialog-actions \.primary-button\s*\{[^}]*font-weight:\s*400;/su,
  );
});

test("keeps create-patent dialog action buttons at the same height", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-dialog \.dialog-actions button\s*\{[^}]*min-height:\s*38px;[^}]*height:\s*38px;/su,
  );
});

test("animates create-patent dialog action hover states", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-dialog \.dialog-actions button\s*\{[^}]*transition:[^;]*background-color[^;]*border-color[^;]*box-shadow/su,
  );
  expect(css).toMatch(
    /\.patent-dialog \.dialog-actions button:hover:not\(:disabled\),\s*\.patent-dialog \.dialog-actions button:focus-visible\s*\{[^}]*background:/su,
  );
  expect(css).toMatch(
    /\.patent-dialog \.dialog-actions \.primary-button:hover:not\(:disabled\),\s*\.patent-dialog \.dialog-actions \.primary-button:focus-visible\s*\{[^}]*background:\s*#1d4ed8;/su,
  );
});

test("uses the readable stacked layout for double-column patent cards", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.library-card-title-content\s*\{[^}]*align-items:\s*center;/su);
  expect(css).toMatch(
    /\.patent-library-month-cards\[data-view-mode="double"\] \.library-card\s*\{[^}]*position:\s*relative;[^}]*display:\s*block;[^}]*padding:\s*16px 52px 0 18px;/su,
  );
  expect(css).toMatch(
    /\.patent-library-month-cards\[data-view-mode="double"\] \.library-card-title-content\s*\{[^}]*align-items:\s*flex-start;/su,
  );
  expect(css).toMatch(
    /\.patent-library-month-cards\[data-view-mode="double"\] \.library-card-meta\s*\{[^}]*padding:\s*12px 0 16px;[^}]*border-top:\s*1px solid #e2e8f0;/su,
  );
  expect(css).toMatch(
    /\.patent-library-month-cards\[data-view-mode="double"\] \.patent-card-actions\s*\{[^}]*position:\s*absolute;[^}]*top:\s*50%;[^}]*right:\s*12px;[^}]*transform:\s*translateY\(-50%\);/su,
  );
});

test("keeps illustrated patent cards separated and bounded by their grid tracks", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-library-month-cards\[data-view-mode="illustrated"\]\s*\{[^}]*gap:\s*18px;/su,
  );
  expect(css).toMatch(
    /\.patent-illustrated-card\.library-card\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*box-sizing:\s*border-box;/su,
  );
});

test("does not clip the illustrated abstract hover preview at the trigger", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(/\.patent-illustrated-card__abstract-hover\s*\{[^}]*overflow:\s*visible;/su);
});

test("previews patent tab drops with a fixed ghost and a blue half-workspace frame", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-workspace-tab-drag\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*z-index:\s*var\(--ui-layer-panel\);[^}]*pointer-events:\s*none;/su,
  );
  expect(css).toMatch(
    /\.patent-workspace-tab-drag__ghost\s*\{[^}]*position:\s*fixed;[^}]*border:\s*1px solid #60a5fa;[^}]*box-shadow:/su,
  );
  expect(css).toMatch(
    /\.patent-workspace-tab-drag__zone\.is-target\s*\{[^}]*border-color:\s*#2563eb;[^}]*background:\s*rgb\(219 234 254 \/ 24%\);/su,
  );
});

test("animates tab-drop cancellation and workspace previews without motion when requested", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-workspace-tab-drag\[data-status="cancelling"\] \.patent-workspace-tab-drag__ghost\s*\{[^}]*transition:[^}]*left 200ms[^}]*top 200ms/su,
  );
  expect(css).toMatch(
    /\.standard-workspace-pane\[data-workspace-tab-drag-effect="split-other"\][^}]*> \*\s*\{[^}]*transform:\s*translateX\(var\(--workspace-tab-preview-shift\)\);/su,
  );
  const workspacePreviewCss = css.slice(
    css.indexOf(".standard-workspace-pane[data-workspace-tab-drag-effect]"),
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  expect(workspacePreviewCss).not.toContain("scale(");
  expect(workspacePreviewCss).not.toContain('data-workspace-tab-drag-effect="swap"');
  expect(css).toMatch(
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.patent-workspace-tab-drag__ghost,[\s\S]*\.standard-workspace-pane\[data-workspace-tab-drag-effect\][\s\S]*\{[^}]*transition:\s*none;/su,
  );
});

test("styles the snapshot content preview as a selectable read-only diff workspace", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  expect(css).toMatch(
    /\.snapshot-content-preview__surface\s*\{[^}]*width:\s*min\(94vw,\s*1640px\);[^}]*height:\s*min\(91vh,\s*970px\);/su,
  );
  expect(css).toMatch(
    /\.snapshot-content-preview__body\s*\{[^}]*grid-template-columns:\s*236px\s+minmax\(760px,\s*1fr\)\s+282px;/su,
  );
  expect(css).toMatch(/\.snapshot-content-preview__workspace\s*\{[^}]*overflow:\s*auto;/su);
  expect(css).toMatch(
    /\[data-snapshot-change-kind="insert"\]\s*\{[^}]*color:\s*#b91c1c;[^}]*background:\s*#fee2e2;/su,
  );
  expect(css).toMatch(
    /\[data-snapshot-change-kind="delete"\]\s*\{[^}]*text-decoration:\s*line-through;/su,
  );
  expect(css).toMatch(
    /\[data-snapshot-change-kind="format"\]\s*\{[^}]*text-decoration-style:\s*dotted;[^}]*text-decoration-color:\s*#2563eb;/su,
  );
  expect(css).toMatch(
    /\[data-snapshot-change-kind="structure"\]\s*\{[^}]*box-shadow:\s*inset 3px 0 0 #2563eb;/su,
  );
  expect(css).toMatch(
    /\.snapshot-book-preview \.patent-figure button,[\s\S]*\.snapshot-book-preview \.chemical-structure button,[\s\S]*\{[^}]*display:\s*none;/su,
  );
  expect(css).toMatch(/@media \(max-width:\s*1380px\)[\s\S]*\.snapshot-content-preview__body/su);
  expect(css).toMatch(
    /@media \(max-width:\s*899px\)[\s\S]*\.snapshot-content-preview__workspace\s*\{[^}]*grid-column:\s*auto;/su,
  );
});

test("modeless dialog stack order is relative to the shared dialog layer", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.dialog-layer--modeless\s*\{[^}]*z-index:\s*calc\(var\(--ui-layer-dialog\) \+ var\(--modeless-dialog-stack-order, 0\)\);/su,
  );
  expect(css).toMatch(
    /\.dialog-backdrop\.dialog-layer--modal,[\s\S]*?\.matrix-insert-backdrop\.dialog-layer--modal\s*\{[^}]*z-index:\s*var\(--ui-layer-critical\);/su,
  );
});

test("uses a theme-aware frame with an orange fallback for transient function-rail panels", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-global-function-rail__body \.function-rail-transient-panel\s*\{[^}]*box-sizing:\s*border-box;[^}]*background:\s*var\(--editor-display-panel, #fff\);[^}]*border:\s*2px solid var\(--editor-display-panel-line, #d97706\);[^}]*border-radius:\s*10px;/su,
  );
});

test("gives a single-pane auxiliary editor the same scrollable viewport height as patent books", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-function-rail-scope\[data-function-rail-scope="single"\]\s*>\s*\.editor-workspace\s*\{[^}]*height:\s*100%;/su,
  );
});

test("truncates a long direct auxiliary tab title without losing its fixed action space", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");

  expect(css).toMatch(
    /\.patent-book-tabs__auxiliary-tab-label\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/su,
  );
});

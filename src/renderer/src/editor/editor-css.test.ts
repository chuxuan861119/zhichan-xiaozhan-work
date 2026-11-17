/// <reference types="node" />

import { readFileSync } from "node:fs";

test("table annotation inputs have equal fixed widths and grow with their content", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const rule = css.match(/\.table-rail-panel__annotation-field textarea\s*\{([^}]*)\}/u)?.[1] ?? "";
  expect(rule).toMatch(/field-sizing:\s*content;/u);
  expect(rule).toMatch(/width:\s*100%;/u);
  expect(rule).toMatch(/min-height:\s*calc\(1\.5em \+ 18px\);/u);
  expect(rule).toMatch(/line-height:\s*1\.5;/u);
});

test("table insertion uses a centered drawn plus with a smaller visual ring", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const button = css.match(/\.table-insert-handle\s*\{([^}]*)\}/u)?.[1];
  expect(button).toMatch(/width:\s*20px/);
  expect(button).toMatch(/font-size:\s*0/);
  expect(css).toMatch(/\.table-insert-handle::before\s*\{[^}]*inset:\s*2px/);
  expect(css).toMatch(/\.table-insert-handle::after\s*\{[^}]*translate\(-50%, -50%\)/);
});

test("lists reserve two characters for indentation and one for the native marker", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  expect(css).toContain("padding-inline-start: 3em;");
  expect(css).toContain("list-style-position: outside;");
});

test("list paragraphs do not stack body first-line indentation onto list indentation", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const rule = css.match(/\.patent-prosemirror li > p\s*\{([^}]*)\}/u)?.[1];
  expect(rule).toMatch(/text-indent:\s*0\s*!important;/u);
});

test("active keyword blocks use soft cyan without overriding text color", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const rule = css.match(/\.reference-mark-keyword-block\.is-active\s*\{([^}]*)\}/u)?.[1];
  expect(rule).toMatch(/background:\s*#b2ebf2;/u);
  expect(rule).not.toMatch(/(?:^|[;\s])color\s*:/u);
});

test("table cell selection remains visible without covering selected text", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(".patent-prosemirror .selectedCell::after");
  expect(css).toContain("pointer-events: none");
  expect(css).toContain("background: rgb(37 99 235 / 14%)");
});

test("table rail controls remain outside the editable table content", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(".table-rail-panel");
  expect(css).toContain(".table-rail-panel__buttons");
  expect(css).toContain(".table-rail-panel__button.is-danger");
  expect(css).toContain(".table-rail-panel__line-style");
  expect(css).toContain(".table-rail-panel__group-toggle");
  expect(css).toContain(".table-rail-panel__group-chevron");
  expect(css).toContain(".table-rail-panel__group-content[hidden]");
  expect(css).toContain(".table-rail-panel__button--icon");
  expect(css).toContain(".table-rail-panel__buttons--operation");
  expect(css).toContain(".table-rail-panel__buttons--cell");
  expect(css).toContain("min-height: 32px");
});

test("table rail buttons use clearly distinct hover and selected states", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const railCss = readFileSync(
    "src/renderer/src/patents/function-rail/function-rail-appearance.css",
    "utf8",
  );
  const hoverRule =
    css.match(
      /\.table-rail-panel__button:hover:not\(:disabled\):not\(\[data-unavailable="true"\]\),\s*\.table-rail-panel__button:focus-visible\s*\{([^}]*)\}/u,
    )?.[1] ?? "";
  const activeRule =
    css.match(/\.table-rail-panel__button\.is-active[^{}]*\{([^}]*)\}/u)?.[1] ?? "";

  expect(hoverRule).toMatch(/color:\s*#0f172a;/u);
  expect(hoverRule).toMatch(/background:\s*#e2e8f0;/u);
  expect(hoverRule).toMatch(/border-color:\s*#cbd5e1;/u);
  expect(activeRule).toMatch(/font-weight:\s*600;/u);
  expect(activeRule).toMatch(/background:\s*#eaf2fb;/u);
  expect(activeRule).toMatch(/border-color:\s*#a9c5e8;/u);
  expect(activeRule).toMatch(/box-shadow:\s*0 1px 2px rgb\(37 99 235 \/ 6%\)/u);

  const railHoverRule =
    railCss.match(
      /\.patent-global-function-rail\s+\.table-rail-panel__button:hover:not\(:disabled\):not\(\[data-unavailable="true"\]\):not\(\.is-danger\),\s*\.patent-global-function-rail\s+\.table-rail-panel__button:focus-visible:not\(\.is-danger\)\s*\{([^}]*)\}/u,
    )?.[1] ?? "";
  const railActiveRule =
    railCss.match(
      /\.patent-global-function-rail \.table-rail-panel__button\.is-active\s*\{([^}]*)\}/u,
    )?.[1] ?? "";

  expect(railHoverRule).toMatch(/background:\s*#e2e8f0;/u);
  expect(railHoverRule).toMatch(/border-color:\s*#cbd5e1;/u);
  expect(railActiveRule).toMatch(/font-weight:\s*600;/u);
  expect(railActiveRule).toMatch(/background:\s*#eaf2fb;/u);
  expect(railActiveRule).toMatch(/border-color:\s*#a9c5e8;/u);
  expect(railActiveRule).toMatch(/box-shadow:\s*0 1px 2px rgb\(37 99 235 \/ 6%\)/u);
  expect(railCss).toContain(
    ".patent-global-function-rail .table-rail-panel__button--icon:not(.is-active)",
  );
});

test("table selection handles stay on cell edges", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(".table-selection-handle");
  expect(css).toContain(".table-selection-handle[data-table-selection-row]");
  expect(css).toContain("padding: 36px");
  expect(css).toContain("margin: calc(5mm - 36px) -36px");
});

test("single-cell selection handle stays in the upper-left padding with a compact hit area", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const selector = String.raw`\.table-selection-handle:not\(\[data-table-selection-row\]\):not\(\[data-table-selection-column\]\):not\(\s*\[data-table-selection-table\]\s*\)`;
  const rules = [...css.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "gu"))].map(
    (match) => match[1] ?? "",
  );
  const positionRule = rules.find((rule) => /\btop\s*:/u.test(rule)) ?? "";
  const hitAreaRule = css.match(new RegExp(`${selector}::before\\s*\\{([^}]*)\\}`, "u"))?.[1] ?? "";
  const visualRule = css.match(new RegExp(`${selector}::after\\s*\\{([^}]*)\\}`, "u"))?.[1] ?? "";

  expect(positionRule).toMatch(/top:\s*1px;/u);
  expect(positionRule).toMatch(/left:\s*1px;/u);
  expect(positionRule).toMatch(/width:\s*7px;/u);
  expect(positionRule).toMatch(/height:\s*7px;/u);
  expect(hitAreaRule).toMatch(/inset:\s*-1px;/u);
  expect(visualRule).toMatch(/display:\s*none;/u);
});

test("row column and table selection targets use a 15px pointer hit area outside cell content", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const ruleFor = (attribute: string, pseudo = "") => {
    const selector = `.table-selection-handle[data-table-selection-${attribute}]${pseudo}`;
    return [...css.matchAll(/([^{}]+)\{([^}]*)\}/gu)]
      .filter((match) =>
        (match[1] ?? "")
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .split(",")
          .map((candidate) => candidate.trim())
          .includes(selector),
      )
      .map((match) => match[2] ?? "")
      .join("\n");
  };

  for (const attribute of ["row", "column", "table"]) {
    expect(ruleFor(attribute)).toMatch(/width:\s*15px;/u);
    expect(ruleFor(attribute)).toMatch(/height:\s*15px;/u);
    expect(ruleFor(attribute)).toMatch(/cursor:\s*pointer;/u);
    expect(ruleFor(attribute, "::before")).toMatch(/inset:\s*0;/u);
    expect(ruleFor(attribute, "::after")).toMatch(
      attribute === "table" ? /inset:\s*3px;/u : /inset:\s*4px;/u,
    );
  }

  expect(ruleFor("row")).toMatch(/top:\s*50%;/u);
  expect(ruleFor("row")).toMatch(/left:\s*0;/u);
  expect(ruleFor("row")).toMatch(/transform:\s*translateY\(-50%\);/u);
  expect(ruleFor("row", "::after")).toMatch(/transform:\s*translateX\(-4px\);/u);
  expect(ruleFor("column")).toMatch(/top:\s*0;/u);
  expect(ruleFor("column")).toMatch(/left:\s*50%;/u);
  expect(ruleFor("column")).toMatch(/transform:\s*translateX\(-50%\);/u);
  expect(ruleFor("column", "::after")).toMatch(/transform:\s*translateY\(-4px\);/u);
  expect(ruleFor("table")).toMatch(/top:\s*0;/u);
  expect(ruleFor("table")).toMatch(/left:\s*0;/u);
  expect(ruleFor("table", "::after")).toMatch(/transform:\s*translate\(-3px,\s*-3px\);/u);
});

test("external table selection dots reveal from non-clickable edge strips", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const revealRule = css.match(/\.table-selection-handle-reveal\s*\{([^}]*)\}/u)?.[1] ?? "";

  expect(revealRule).toMatch(/cursor:\s*default;/u);
  expect(css).toContain(".table-selection-handle-reveal:hover > .table-selection-handle");
  expect(css).toContain(".table-selection-handle-reveal:focus-within > .table-selection-handle");
  expect(css).toMatch(
    /\.table-selection-handle-reveal\[data-table-selection-reveal="row"\]\s*\{[^}]*top:\s*0;[^}]*left:\s*-11px;[^}]*width:\s*12px;[^}]*height:\s*100%;/u,
  );
  expect(css).toMatch(
    /\.table-selection-handle-reveal\[data-table-selection-reveal="column"\]\s*\{[^}]*top:\s*-11px;[^}]*left:\s*0;[^}]*width:\s*100%;[^}]*height:\s*12px;/u,
  );
  expect(css).toMatch(
    /\.table-selection-handle-reveal\[data-table-selection-reveal="table"\]\s*\{[^}]*top:\s*-24px;[^}]*left:\s*-24px;[^}]*width:\s*13px;[^}]*height:\s*13px;/u,
  );
  expect(css).toMatch(
    /table:has\([\s\S]*?\.table-selection-handle-reveal:is\([\s\S]*?\[data-table-selection-reveal="row"\],[\s\S]*?\[data-table-selection-reveal="column"\],[\s\S]*?\[data-table-selection-reveal="table"\][\s\S]*?\):hover[\s\S]*?\)\s*\.table-selection-handle:is\(/u,
  );
});

test("table hover reveals only its corner control while resize handles remain quiet", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(
    ".patent-prosemirror table:hover .table-selection-handle[data-table-selection-table]",
  );
  expect(css).not.toMatch(/table:hover \.table-selection-handle\s*\{/u);
  expect(css).not.toContain(".patent-prosemirror table:focus-within .table-selection-handle");
  expect(css).not.toContain(".patent-prosemirror table:hover .table-row-resize-handle");
  expect(css).not.toContain(".patent-prosemirror table:focus-within .table-row-resize-handle");
  expect(css).toContain(".table-selection-handle:hover");
  expect(css).toContain(".table-selection-handle:focus-visible");
  expect(css).toContain(".table-row-resize-handle:hover");
  expect(css).toContain(".table-row-resize-handle:focus-visible");
});

test("table cell selections draw blue borders only on the selection perimeter", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const selectionRule =
    css.match(/\.patent-prosemirror \.selectedCell::after\s*\{([^}]*)\}/u)?.[1] ?? "";

  expect(selectionRule).toMatch(/background:\s*rgb\(37 99 235 \/ 14%\);/u);
  expect(selectionRule).toMatch(/border:\s*0 solid #2563eb;/u);
  expect(selectionRule).not.toMatch(/box-shadow:/u);
  expect(css).toMatch(
    /\.selectedCell\.table-selection-boundary-top::after\s*\{[^}]*border-top-width:\s*1px;/u,
  );
  expect(css).toMatch(
    /\.selectedCell\.table-selection-boundary-right::after\s*\{[^}]*border-right-width:\s*1px;/u,
  );
  expect(css).toMatch(
    /\.selectedCell\.table-selection-boundary-bottom::after\s*\{[^}]*border-bottom-width:\s*1px;/u,
  );
  expect(css).toMatch(
    /\.selectedCell\.table-selection-boundary-left::after\s*\{[^}]*border-left-width:\s*1px;/u,
  );
});

test("row and column resize guides share a continuous two-pixel highlight", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const columnGuide =
    css.match(/\.patent-prosemirror \.column-resize-handle\s*\{[^}]*\}/u)?.[0] ?? "";
  const rowGuide = css.match(/\.table-row-resize-handle::after\s*\{[^}]*\}/u)?.[0] ?? "";

  expect(columnGuide).toContain("right: -1px");
  expect(columnGuide).toContain("width: 2px");
  expect(rowGuide).toContain("height: 2px");
  expect(css).toMatch(
    /\.patent-prosemirror:not\(\[data-table-selection-dragging="true"\]\)\s+tr:has\(\.table-row-resize-handle:hover\)\s+\.table-row-resize-handle/u,
  );
  expect(css).toMatch(
    /\.patent-prosemirror:not\(\[data-table-selection-dragging="true"\]\)\s+tr:has\(\.table-row-resize-handle:focus-visible\)\s+\.table-row-resize-handle/u,
  );
});

test("row resize hover guides stay hidden while selecting cells by dragging", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(
    '.patent-prosemirror:not([data-table-selection-dragging="true"]) .table-row-resize-handle:hover',
  );
  expect(css).toMatch(
    /\.patent-prosemirror:not\(\[data-table-selection-dragging="true"\]\)\s+tr:has\(\.table-row-resize-handle:hover\)\s+\.table-row-resize-handle/u,
  );
  expect(css).not.toMatch(/(?:^|,)\s*\.table-row-resize-handle:hover\s*(?:,|\{)/mu);
});

test("row resize preview preserves the normal minimum height of compact cells", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const previewContentRule =
    css.match(
      /\.patent-prosemirror tr\[data-table-row-resize-preview="true"\] \.patent-table-cell-content\s*\{([^}]*)\}/u,
    )?.[1] ?? "";

  expect(previewContentRule).not.toMatch(/min-height:/u);
  expect(previewContentRule).toMatch(/max-height:\s*none;/u);
  expect(previewContentRule).toMatch(/overflow:\s*visible;/u);
});

test("math and chemistry formula nodes show hover and selection feedback", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain('.patent-prosemirror [data-type="inline-math"]:hover');
  expect(css).toContain('.patent-prosemirror .ProseMirror-selectednode[data-type="inline-math"]');
  expect(css).toContain('.patent-prosemirror .ProseMirror-selectednode[data-type="block-math"]');
  expect(css).toContain("background-color: rgb(37 99 235 / 15%)");
  expect(css).toContain(".chemical-structure.is-selected");
});

test("figure selection remains visible from the canonical ProseMirror node-selection class", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(".ProseMirror-selectednode > .patent-figure > .image-selection-frame");
  expect(css).toContain(
    ".ProseMirror-selectednode > .patent-inline-figure > .image-selection-frame",
  );
  expect(css).toMatch(
    /\.ProseMirror-selectednode\s*>\s*\.patent-figure\s*>\s*\.image-selection-frame\s*>\s*\.image-selection-frame__resize/u,
  );
  expect(css).toContain(".image-selection-frame__delete::before");
  expect(css).toContain(".image-selection-frame__resize::before");
  expect(css).toContain("inset: -4px");
  expect(css).toContain("inset: -5px");
});

test("superscript and subscript render as shrunken inline offsets without stretching line height", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(".patent-prosemirror sub,");
  expect(css).toContain(".patent-prosemirror sup {");
  expect(css).toContain("line-height: 0");
  expect(css).toContain("vertical-align: baseline");
  expect(css).toContain("position: relative");
});

test("script input mode aligns small carets with script text and provides a normal exit caret", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(".patent-prosemirror.has-script-input-caret");
  expect(css).toContain(".script-input-caret::after");
  expect(css).toContain('[data-script-input-caret="superscript"]::after');
  expect(css).toContain('[data-script-input-caret="subscript"]::after');
  expect(css).toContain('[data-script-input-caret="normal"]::after');
  expect(css).toContain("height: 0.65em");
  const superscriptCaret =
    css.match(/\[data-script-input-caret="superscript"\]::after \{[^}]*\}/u)?.[0] ?? "";
  const subscriptCaret =
    css.match(/\[data-script-input-caret="subscript"\]::after \{[^}]*\}/u)?.[0] ?? "";
  const normalCaret =
    css.match(/\[data-script-input-caret="normal"\]::after \{[^}]*\}/u)?.[0] ?? "";
  expect(superscriptCaret).toContain("bottom: 0.3em");
  expect(subscriptCaret).toContain("bottom: -0.2em");
  expect(normalCaret).toContain("height: 1em");
  expect(normalCaret).toContain("bottom: 0");
});

test("selected text keeps its own color on a visible, soft selection background", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  // Once ::selection sets a custom color, the UA default background stops
  // applying; an explicit background is required so the selection stays
  // visible while the text color (e.g. freshly applied ink) remains readable.
  // The tint is a soft translucent blue, not the harsh system highlight.
  const selectionBlock = css.match(/\.patent-prosemirror ::selection \{[^}]*\}/u)?.[0] ?? "";
  expect(css).toContain("--editor-selection-background: rgb(37 99 235 / 22%)");
  expect(selectionBlock).toContain("color: inherit");
  expect(selectionBlock).toContain("background: var(--editor-selection-background)");
  expect(selectionBlock).not.toContain("transparent");
});

test("uses a contrast-aware native caret color", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain("--editor-caret-color: #1d4ed8");
  expect(css).toContain("caret-color: var(--editor-caret-color, #1d4ed8)");
});

test("uses native Chinese wrapping without overriding alignment or compressing text", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const editor = css.match(/\.patent-prosemirror \{[^}]*\}/u)?.[0] ?? "";

  expect(editor).toContain("overflow-wrap: break-word");
  expect(editor).toContain("word-break: normal");
  expect(editor).toContain("line-break: strict");
  expect(editor).toContain("text-justify: inter-character");
  expect(editor).toContain("text-align-last: auto");
  expect(editor).toContain("text-spacing-trim: normal");
  expect(editor).toContain("letter-spacing: normal");
  expect(editor).not.toContain("overflow-wrap: anywhere");
  expect(css).not.toContain("has-cjk-hanging-punctuation");
});

test("reference-mark keyword blocks remain selection-safe and use display-only smaller text", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const block = css.match(/\.reference-mark-keyword-block \{[^}]*\}/u)?.[0] ?? "";
  const recent = css.match(/\.reference-mark-keyword-block\.is-recent \{[^}]*\}/u)?.[0] ?? "";

  expect(block).toContain("margin-inline: 0");
  expect(block).toContain("padding: 0");
  expect(block).toContain("font-size: 0.9em");
  expect(block).toContain("vertical-align: baseline");
  expect(block).toContain("cursor: text");
  expect(block).not.toContain("box-shadow");
  expect(recent).toContain("background: #dcfce7");
  expect(recent).not.toContain("box-shadow");
  expect(recent).not.toContain("#86efac");
});

test("renders underlined template blanks with a fine, readable line", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  const underlineBlock = css.match(/\.patent-prosemirror u \{[^}]*\}/u)?.[0] ?? "";

  expect(underlineBlock).toContain("text-decoration-thickness: 0.75px");
  expect(underlineBlock).toContain("text-underline-offset: 0.08em");
});

test("inactive selection overlays use distinct active and background tones", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain("--editor-selection-background: rgb(37 99 235 / 22%)");
  expect(css).toContain("--editor-inactive-selection-background: rgb(100 116 139 / 28%)");
  expect(css).toContain("background: var(--editor-selection-background)");
  expect(css).toContain(".editor-selection-overlay-host");
  expect(css).toContain('.editor-selection-overlay[data-tone="active"]');
  expect(css).toContain('.editor-selection-overlay[data-tone="background"]');
  expect(css).toContain("background: var(--editor-inactive-selection-background)");
  expect(css).not.toContain(".text-polish-selection-highlight");
});

test("chemical suggestions and active script input have visible compact states", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toContain(".chemistry-suggestion-bar");
  expect(css).toContain('.chemistry-suggestion-option[aria-selected="true"]');
  expect(css).toContain('.chemistry-symbols button[aria-pressed="true"]');
  expect(css).toContain(".chemistry-script-hint");
});

test("chemical footer alignment does not rely on negative margins", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).not.toContain("margin-left: -30px");
});

test("keeps find options compact and the special-character dialog dense", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

  expect(css).toMatch(
    /\.find-replace-panel__search-tools\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/su,
  );
  expect(css).toMatch(
    /\.find-replace-panel__options\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/su,
  );
  expect(css).toMatch(
    /\.special-character-dialog__options\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/su,
  );
  expect(css).toMatch(/\.special-character-dialog__option\s*\{[^}]*min-height:\s*76px;/su);
  expect(css).toMatch(
    /\.special-character-dialog__options small\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/su,
  );
  expect(css).toMatch(
    /@media \(max-width:\s*480px\)[\s\S]*?\.special-character-dialog__options\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u,
  );
});

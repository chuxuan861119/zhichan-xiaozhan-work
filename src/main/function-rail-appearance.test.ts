import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("minimal function rail appearance", () => {
  test("uses the approved compact preview typography and tool geometry", () => {
    const css = readFileSync(
      resolve("src/renderer/src/patents/function-rail/function-rail-appearance.css"),
      "utf8",
    );
    const label = css.match(
      /\n\.patent-global-function-rail \.compact-tool-actions__label \{([^}]+)\}/,
    )?.[1];
    expect(label).toContain("font-size: 14px;");
    expect(label).toContain("font-weight: 600;");
    expect(label).toContain("line-height: 22px;");
    expect(css).toMatch(/\.patent-global-function-rail__body \{\s*gap: 0;/);
    expect(css).toMatch(
      /\.patent-global-function-rail__body > \* \+ \* \{\s*margin-block-start: 12px;/,
    );
    const button = css.match(/\.compact-drawing-import > button \{([^}]+)\}/)?.[1];
    expect(button).toContain("min-height: 36px;");
    expect(button).toContain("padding: 6px 0;");
    expect(button).toContain("line-height: 20px;");
  });

  test("keeps the description outline above hover backgrounds without covering content", () => {
    const css = readFileSync(resolve("src/renderer/src/patents/compact-tool-actions.css"), "utf8");
    const outline = css.match(/\.claims-description-tool__outline\s*\{([^}]+)\}/)?.[1];
    expect(outline).toContain("z-index: 2;");
    expect(outline).toContain("pointer-events: none;");
    expect(css).toMatch(/\.claims-description-tool__outline path\s*\{\s*fill: none;/);
  });

  test("shares the row outline between validation issues and editing", () => {
    const css = readFileSync(
      resolve("src/renderer/src/patents/function-rail/function-rail-appearance.css"),
      "utf8",
    );
    expect(css).toMatch(
      /div\.is-issue,\s*\.patent-global-function-rail \.reference-mark-panel__rows > div\.is-editing\s*\{/,
    );
  });

  test("encloses the entire editing reference row in a theme border with an orange fallback", () => {
    const css = readFileSync(
      resolve("src/renderer/src/patents/function-rail/function-rail-appearance.css"),
      "utf8",
    );
    const row = css.match(/\.reference-mark-panel__rows > div\.is-editing\s*\{([^}]+)\}/)?.[1];
    expect(row).toContain("border: 1px solid var(--editor-display-panel-line, #ec9d56);");
    expect(row).toContain("padding: 8px;");
  });

  test("loads native customizable pickers scoped to the function rail", () => {
    const app = readFileSync(resolve("src/renderer/src/app/App.tsx"), "utf8");
    const css = readFileSync(
      resolve("src/renderer/src/patents/function-rail/function-rail-select.css"),
      "utf8",
    );
    expect(app).toContain('import "../patents/function-rail/function-rail-select.css"');
    expect(css).toContain("@supports (appearance: base-select)");
    expect(css).toContain(".patent-global-function-rail select::picker(select)");
    expect(css).toContain("option:checked");
    expect(css).toContain("option:disabled");
  });

  test("does not apply standalone delete spacing to grouped table commands", () => {
    const css = readFileSync(
      resolve("src/renderer/src/patents/function-rail/function-rail-appearance.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.table-rail-panel__buttons \.table-rail-panel__button\.is-danger\s*\{\s*margin-top: 0;/,
    );
  });

  test("aligns docked cards to the page without the removed backplate inset", () => {
    const css = readFileSync(
      resolve("src/renderer/src/patents/function-rail/function-rail-appearance.css"),
      "utf8",
    );
    const docked =
      css.match(
        /\.patent-global-function-rail-slot\[data-layout="docked"\] \.patent-global-function-rail \{([^}]+)\}/,
      )?.[1] ?? "";
    expect(docked).toContain("padding: 20px 0;");
    expect(docked).toContain("top: var(--rail-viewport-offset, -20px);");
    expect(docked).toContain("border: 0;");
  });

  test("preserves the shared rail positioning in the transparent theme", () => {
    const css = readFileSync(
      resolve("src/renderer/src/patents/function-rail/function-rail-appearance.css"),
      "utf8",
    );
    const rail = css.match(/\.patent-global-function-rail \{([^}]+)\}/)?.[1] ?? "";
    const header = css.match(/\.patent-global-function-rail__header \{([^}]+)\}/)?.[1] ?? "";
    // Inherit main's 10px inset; keep the invisible border's layout space.
    expect(rail).not.toMatch(/\bpadding\s*:/);
    expect(rail).toContain("border: 1px solid transparent;");
    expect(header).toContain("padding: 0;");
    expect(rail).toContain("background: transparent;");
  });

  test("loads the scoped theme after legacy rail rules", () => {
    const source = readFileSync(resolve("src/renderer/src/app/App.tsx"), "utf8");
    expect(
      source.indexOf('import "../patents/function-rail/function-rail-appearance.css"'),
    ).toBeGreaterThan(source.indexOf('import "../patents/compact-tool-actions.css"'));
  });

  test("keeps overlay geometry aligned with docked geometry across responsive changes", () => {
    const source = readFileSync(
      resolve("src/renderer/src/patents/patent-global-function-rail.tsx"),
      "utf8",
    );
    const css = readFileSync(
      resolve("src/renderer/src/patents/function-rail/function-rail-responsive.css"),
      "utf8",
    );
    expect(source).toContain('import "./function-rail/function-rail-responsive.css"');
    expect(css).toMatch(
      /\.patent-function-rail-edge-host\s*>\s*\.patent-global-function-rail-slot\[data-layout="overlay"\]\s*\{[^}]*top:\s*20px;/s,
    );
    expect(css).toMatch(
      /\.patent-global-function-rail-slot\[data-layout="overlay"\]\s+\.patent-global-function-rail\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;/s,
    );
  });
});

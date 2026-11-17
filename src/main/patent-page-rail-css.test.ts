import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("patent page rail CSS layout contract", () => {
  test("keeps the shared page rail layout from shrinking the patent page", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/src/app/app.css"), "utf8");

    expect(css).toContain("--patent-book-page-width: 820px");
    expect(css).toMatch(
      /\.patent-page-with-rail\s*\{[^}]*grid-template-columns:\s*var\(--document-structure-ruler-reserved-width\)\s+calc\(var\(--patent-book-page-width\) \* var\(--patent-page-zoom\)\)\s+var\(--patent-function-rail-reserved-width\);/su,
    );
    expect(css).toMatch(
      /\.patent-page-with-rail:not\(\[data-pane-rail-space="constrained"\]\):has\(\s*> \.patent-global-function-rail-slot\[data-layout="docked"\]\s*\)\s*\{[^}]*--patent-function-rail-reserved-width:\s*calc\(\s*var\(--patent-function-rail-width\)\s*\+\s*var\(--patent-function-rail-gap\)\s*\);/su,
    );
    expect(css).toMatch(
      /\.patent-page-zoom-frame\s*\{[^}]*grid-column:\s*2;[^}]*width:\s*var\(--patent-book-page-width\);/su,
    );
  });

  test("reserves the editor scrollbar gutter before long pages need scrolling", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/src/app/app.css"), "utf8");

    expect(css).toContain("scrollbar-gutter: stable");
  });

  test("keeps the drawing page at the same initial height as other patent books", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/src/app/app.css"), "utf8");

    expect(css).toContain("--patent-book-page-min-height: 1050px");
    expect(css).toMatch(
      /\.drawing-page\s*\{[^}]*min-height:\s*var\(--patent-book-page-min-height\)/su,
    );
    expect(css).toMatch(
      /\.patent-book-editor-layout \.patent-book-rich-text\s*\{[^}]*min-height:\s*var\(--patent-book-page-min-height\)/su,
    );
    expect(css).not.toContain("min-height: calc(100vh - 300px)");
  });
});

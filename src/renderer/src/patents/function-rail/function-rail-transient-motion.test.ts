import { readFileSync } from "node:fs";

test("transient rail panels expand downward, collapse upward and honor reduced motion", () => {
  const css = readFileSync(
    "src/renderer/src/patents/function-rail/function-rail-appearance.css",
    "utf8",
  );

  expect(css).toMatch(
    /\.function-rail-transient-slot\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*1fr;[^}]*transform-origin:\s*top;/su,
  );
  expect(css).toMatch(
    /\.function-rail-transient-slot\[data-motion="exit"\]\s*\{[^}]*grid-template-rows:\s*0fr;[^}]*opacity:\s*0;[^}]*transform:\s*translateY\(-8px\);/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail__body\s*>\s*\*\s*\+\s*\*\s*\{[^}]*margin-block-start:\s*12px;/su,
  );
  expect(css).toMatch(
    /@starting-style\s*\{[^}]*\.function-rail-transient-slot\[data-motion="enter"\][^{]*\{[^}]*grid-template-rows:\s*0fr;[^}]*opacity:\s*0;/su,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.function-rail-transient-slot\s*\{[^}]*transition:\s*none;/su,
  );
});

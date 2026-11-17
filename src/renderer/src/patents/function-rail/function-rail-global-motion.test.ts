import { readFileSync } from "node:fs";

test("reveals the global function rail downward over 600ms and collapses it upward", () => {
  const css = readFileSync(
    "src/renderer/src/patents/function-rail/function-rail-responsive.css",
    "utf8",
  );

  expect(css).toMatch(
    /\.patent-global-function-rail\[data-motion\]\s*\{[^}]*clip-path:\s*inset\(-32px -32px -32px -32px\);[^}]*transform:\s*translateY\(0\);[^}]*transform-origin:\s*top;[^}]*transition:[^}]*clip-path\s+600ms ease-in-out[^}]*opacity\s+600ms ease-in-out[^}]*transform\s+600ms ease-in-out/su,
  );
  expect(css).toMatch(
    /\.patent-global-function-rail\[data-motion="exit"\]\s*\{[^}]*opacity:\s*0;[^}]*clip-path:\s*inset\(-32px -32px 100% -32px\);[^}]*transform:\s*translateY\(-8px\);[^}]*pointer-events:\s*none;/su,
  );
  expect(css).toMatch(
    /@starting-style\s*\{[^}]*\.patent-global-function-rail\[data-motion="enter"\]\s*\{[^}]*opacity:\s*0;[^}]*clip-path:\s*inset\(-32px -32px 100% -32px\);[^}]*transform:\s*translateY\(-8px\);/su,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.patent-global-function-rail\[data-motion\]\s*\{[^}]*transition:\s*none;/su,
  );
  expect(css).toMatch(
    /html\.library-editor-function-rail-entry\s+\.patent-global-function-rail\[data-motion="enter"\]\s*\{[^}]*animation:\s*patent-global-function-rail-enter\s+600ms ease-in-out both;/su,
  );
  expect(css).toMatch(
    /@keyframes patent-global-function-rail-enter\s*\{\s*from\s*\{[^}]*opacity:\s*0;[^}]*clip-path:\s*inset\(-32px -32px 100% -32px\);[^}]*transform:\s*translateY\(-8px\);[^}]*\}\s*to\s*\{[^}]*opacity:\s*1;[^}]*clip-path:\s*inset\(-32px -32px -32px -32px\);[^}]*transform:\s*translateY\(0\);/su,
  );
});

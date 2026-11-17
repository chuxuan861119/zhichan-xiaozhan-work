import { expect, test } from "vitest";
import { rendererFailureLocations } from "./renderer-failure-locations";

test("retains only bounded bundled source coordinates, never exception text or paths", () => {
  const error = new Error("private patent text");
  error.stack = `Error: private patent text
    at secretFunction (patent-app://app/assets/index-AbC_1234.js:123:45)
    at private (file:///D:/private/customer/renderer/assets/index-XyZ-1234.js:456:78)
    at secret (https://private.example/patent.js:22:33)
    at private (patent-app://app/assets/index-AbC_1234.js:123:45)`;
  expect(rendererFailureLocations(error)).toEqual([
    { bundle: "index-AbC_1234.js", line: 123, column: 45 },
    { bundle: "index-XyZ-1234.js", line: 456, column: 78 },
  ]);
  expect(rendererFailureLocations("private text")).toEqual([]);
  error.stack = "Error: no frames";
  expect(rendererFailureLocations(error)).toEqual([]);
});

test("caps coordinates and frame count, and ignores error messages disguised as stacks", () => {
  const error = new Error("private");
  error.stack = `Error: patent-app://app/assets/index-secret99.js:100:10
    at x (patent-app://app/assets/index-AbC_1234.js:9999999999:0)
${Array.from({ length: 20 }, (_, i) => `    at x (patent-app://app/assets/index-AbC_1234.js:${i + 1}:2)`).join("\n")}`;
  expect(rendererFailureLocations(error)).toHaveLength(3);
  expect(rendererFailureLocations(error)[0]).toEqual({
    bundle: "index-AbC_1234.js",
    line: 1,
    column: 2,
  });
});

// @vitest-environment node
import { expect, test } from "vitest";
import { workbenchUiResource } from "./workbench-ui-resources.js";

test("serves only the two bundled shared UI files", async () => {
  const js = await workbenchUiResource("/workbench-ui.js", "resources/ui");
  expect(js?.headers.get("Content-Type")).toContain("javascript");
  expect(await js?.text()).toContain("window.workbenchUi");
  const css = await workbenchUiResource("/workbench-ui.css", "resources/ui");
  expect(css?.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await css?.text()).toContain("box-shadow: none");
  expect(await workbenchUiResource("/../package.json", "resources/ui")).toBeNull();
  expect(await workbenchUiResource("/package.json", "resources/ui")).toBeNull();
  expect(await workbenchUiResource("/nested/workbench-ui.js", "resources/ui")).toBeNull();
});

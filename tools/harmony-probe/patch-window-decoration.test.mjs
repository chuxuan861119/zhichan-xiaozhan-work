import assert from "node:assert/strict";
import test from "node:test";
import { patchNativeFrameAdapter, patchWindowDecoration } from "./patch-window-decoration.mjs";

const template = `      window.setWindowDecorVisible(!this.hideTitleBar);
      this.maximizable = this.maximizable && !this.hideTitleBar;
      this.minimizable = this.minimizable && !this.hideTitleBar;
      this.closable = this.closable && !this.hideTitleBar;
      window.setWindowTitleButtonVisible(this.maximizable, this.minimizable, this.closable);
      this.nativeContext.OnCaptionButtonRectChange(this.xcomponentId, rect);`;

test("native frame updates do not hide caption controls and permission setters work in overlay mode", () => {
  const adapter =
    "      windowClass?.setWindowTitleButtonVisible(useNativeFrame, useNativeFrame, useNativeFrame);\n" +
    "if (!preferences.hideTitleBar && !this.deviceInfoAdapter.isNormalWindowMode())\n".repeat(3);
  const patched = patchNativeFrameAdapter(adapter);
  assert.ok(patched.includes("preferences?.maximizable ?? true"));
  assert.ok(!patched.includes("!preferences.hideTitleBar"));
  assert.equal(patchNativeFrameAdapter(patched), patched);
  assert.throws(
    () => patchNativeFrameAdapter(adapter.replace("useNativeFrame);", "renamed);")),
    /Unsupported/,
  );
});

test("hidden title bar retains caption controls and rectangle forwarding", () => {
  const patched = patchWindowDecoration(template);
  assert.ok(!patched.includes("= this.maximizable && !this.hideTitleBar"));
  assert.ok(!patched.includes("= this.minimizable && !this.hideTitleBar"));
  assert.ok(!patched.includes("= this.closable && !this.hideTitleBar"));
  assert.ok(patched.includes("window.setWindowDecorHeight(38)"));
  assert.ok(
    patched.includes(
      "window.setWindowTitleButtonVisible(this.maximizable, this.minimizable, this.closable)",
    ),
  );
  assert.ok(
    patched.includes("this.nativeContext.OnCaptionButtonRectChange(this.xcomponentId, rect)"),
  );
  assert.equal(patchWindowDecoration(patched), patched);
});

test("rejects changed or ambiguous vendor templates before writing", () => {
  assert.throws(() => patchWindowDecoration(""), /Unsupported/);
  assert.throws(() => patchWindowDecoration(template + template), /Unsupported/);
  assert.throws(
    () => patchWindowDecoration(template.replace("OnCaptionButtonRectChange", "renamed")),
    /Missing window adapter/,
  );
});

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const anchor = [
  "      this.maximizable = this.maximizable && !this.hideTitleBar;",
  "      this.minimizable = this.minimizable && !this.hideTitleBar;",
  "      this.closable = this.closable && !this.hideTitleBar;",
].join("\n");
const replacement = [
  "      // ZXW: retain system caption buttons over the document tab row.",
  "      if (this.hideTitleBar && !this.isPanel) {",
  "        window.setWindowDecorHeight(38);",
  "      }",
].join("\n");

export function patchWindowDecoration(source) {
  if (source.includes(replacement) && !source.includes(anchor)) return source;
  if (source.split(anchor).length !== 2) throw new Error("Unsupported WebAbility window template");
  for (const required of [
    "window.setWindowDecorVisible(!this.hideTitleBar);",
    "window.setWindowTitleButtonVisible(this.maximizable, this.minimizable, this.closable);",
    "this.nativeContext.OnCaptionButtonRectChange(this.xcomponentId, rect);",
  ]) {
    if (!source.includes(required)) throw new Error(`Missing window adapter: ${required}`);
  }
  return source.replace(anchor, replacement);
}

export function patchNativeFrameAdapter(source) {
  const original =
    "      windowClass?.setWindowTitleButtonVisible(useNativeFrame, useNativeFrame, useNativeFrame);";
  const patched = [
    "      // ZXW: frame visibility and caption button permissions are independent.",
    "      let preferences = this.abilityManager.getProxy(id)?.getWindowPreferences();",
    "      windowClass?.setWindowTitleButtonVisible(preferences?.maximizable ?? true, preferences?.minimizable ?? true, preferences?.closable ?? true);",
    "      if (!useNativeFrame) windowClass?.setWindowDecorHeight(38);",
  ].join("\n");
  if (source.includes(patched) && !source.includes(original)) return source;
  if (source.split(original).length !== 2) throw new Error("Unsupported native frame adapter");
  const guard = "!preferences.hideTitleBar && !this.deviceInfoAdapter.isNormalWindowMode()";
  if (source.split(guard).length !== 4) throw new Error("Unsupported caption permission setters");
  return source
    .replace(original, patched)
    .replaceAll(guard, "!this.deviceInfoAdapter.isNormalWindowMode()");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error("Usage: patch-window-decoration.mjs <hap-project>");
  const target = resolve(process.argv[2], "web_engine/src/main/ets/ability/WebAbility.ets");
  const original = await readFile(target, "utf8");
  const patched = patchWindowDecoration(original);
  const adapter = resolve(process.argv[2], "web_engine/src/main/ets/adapter/AppWindowAdapter.ets");
  const adapterOriginal = await readFile(adapter, "utf8");
  const adapterPatched = patchNativeFrameAdapter(adapterOriginal);
  if (patched !== original) await writeFile(target, patched);
  if (adapterPatched !== adapterOriginal) await writeFile(adapter, adapterPatched);
  console.log("Harmony caption overlay adapter ready");
}

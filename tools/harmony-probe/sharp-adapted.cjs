// Shared by Harmony packages and isolated dependency probes.
const fs = require("node:fs");
const path = require("node:path");
// V8 removes WebAssembly when JIT is disabled. Loading sharp's WASM backend
// would throw before the workbench can open any documents in that environment.
const original = typeof WebAssembly === "undefined" ? undefined : require("sharp");
let Resvg;
let fonts;
let initialization;
function adapted(input, options) {
  if (!original) throw new Error("当前运行环境未提供 WebAssembly，暂时无法处理图像。");
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const prefix = Buffer.from(input).subarray(0, 1024).toString("utf8");
    if (/<svg\b/u.test(prefix)) {
      const markup = Buffer.from(input).toString("utf8");
      if (/<text\b/u.test(markup)) {
        if (!Resvg) throw new Error("SVG text adapter has not been initialized");
        const image = new Resvg(markup, {
          font: { fontBuffers: fonts, defaultFontFamily: "Source Han Serif CN" },
        });
        try {
          if (image.imagesToResolve().length > 0)
            throw new Error("SVG external resources are forbidden");
          input = Buffer.from(image.toString(), "utf8");
        } finally {
          image.free();
        }
      }
    }
  }
  return original(input, options);
}
Object.assign(adapted, original);
adapted.initialize = () =>
  (initialization ??= (async () => {
    if (!original) return;
    const renderer = require("@resvg/resvg-wasm");
    await renderer.initWasm(fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
    fonts = ["SourceHanSerifCN-Regular.otf", "SourceHanSerifCN-SemiBold.otf"].map((name) =>
      fs.readFileSync(path.join(__dirname, "fonts", name)),
    );
    Resvg = renderer.Resvg;
  })());
module.exports = adapted;

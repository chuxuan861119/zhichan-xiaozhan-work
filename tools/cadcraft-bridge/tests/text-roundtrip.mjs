import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const root = new URL("../../../", import.meta.url);
const source = await readFile(
  new URL("resources/cadcraft/wasm/cadcraft.js", root),
  "utf8",
);
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({
  module: await readFile(
    new URL("resources/cadcraft/wasm/cadcraft_bg.wasm", root),
  ),
});
const font = new URL(
  "src/shared/document/fonts/SourceHanSerifCN-Regular.otf",
  root,
);
test("multiline text width height and content survive native DXF DWG SVG and reopen", async () => {
  const s = new bridge.CadcraftSession();
  s.register_font("Source Han Serif CN", await readFile(font));
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  const codec = (mode, bytes) =>
    execFileSync(
      fileURLToPath(new URL("resources/cadcraft/cadcraft-codec.exe", root)),
      [mode, "--font", fileURLToPath(font)],
      { input: bytes, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
    );
  try {
    run("bridge.text", {
      at: [10, 20],
      text: "电池冷却装置\nabcdefghi",
      height: 7.29,
      width: 40,
    });
    const before = JSON.parse(s.scene()).entities[0];
    const dxf = s.export_dxf();
    const dwg = codec("dxf-to-dwg", dxf);
    assert.equal(dwg.subarray(0, 2).toString(), "AC");
    const back = codec("dwg-to-dxf", dwg);
    s.load_dxf(back);
    const after = JSON.parse(s.scene()).entities[0];
    for (const field of [
      "plainText",
      "width",
      "height",
      "textOrigin",
      "textLines",
    ])
      assert.deepEqual(after[field], before[field], field);
    const native = JSON.parse(codec("dxf-to-scene", back));
    assert.deepEqual(native.entities[0].textLines, before.textLines);
    const svg = codec("dxf-to-svg", back).toString();
    assert.match(svg, /<svg/);
    assert.match(svg, /<path|<polygon/);
    run("bridge.text", {
      handle: after.handle,
      text: "",
      height: 7.29,
      width: 40,
    });
    assert.equal(JSON.parse(s.scene()).entityCount, 0);
    run("undo", {});
    assert.equal(JSON.parse(s.scene()).entities[0].plainText, before.plainText);
  } finally {
    s.free();
  }
});

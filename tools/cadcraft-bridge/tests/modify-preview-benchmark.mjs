// Isolated synthetic drawing; never reads or edits the user's library.
import { readFile } from "node:fs/promises";

const root = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const source = await readFile(new URL("cadcraft.js", root), "utf8");
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", root)) });
const s = new bridge.CadcraftSession();
try {
  const dxf =
    "0\nSECTION\n2\nENTITIES\n" +
    Array.from(
      { length: 5000 },
      (_, i) => `0\nLINE\n8\n0\n10\n${i * 2}\n20\n100\n11\n${i * 2 + 1}\n21\n101\n`,
    ).join("") +
    "0\nENDSEC\n0\nEOF\n";
  s.load_dxf(new TextEncoder().encode(dxf));
  const run = (c, p) => s.execute(c, JSON.stringify(p));
  const h = JSON.parse(run("rectang", { p1: [0, 0], p2: [10, 10] })).handle;
  const params = { handle: h, pick: [5, 0], mode: "quick" };
  for (const compact of [false, true]) {
    const values = [];
    let size = 0;
    for (let i = 0; i < 6; i++) {
      const t = performance.now();
      const v = run("bridge.preview_modify", { command: "trim", params, compact });
      values.push(performance.now() - t);
      size = v.length;
    }
    console.log(
      JSON.stringify({ compact, medianMs: values.sort((a, b) => a - b)[3], jsonBytes: size }),
    );
  }
  for (const [name, fn] of [
    ["commit", () => run("trim", params)],
    ["scene", () => s.scene()],
    ["export", () => s.export_dxf()],
  ]) {
    const t = performance.now();
    fn();
    console.log(name, performance.now() - t);
  }
} finally {
  s.free();
}

// Synthetic repetitive geometry, independent of the user's documents.
import { readFile } from "node:fs/promises";
const root = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const js = await readFile(new URL("cadcraft.js", root), "utf8");
const bridge = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", root)) });
const s = new bridge.CadcraftSession();
try {
  const text =
    "0\nSECTION\n2\nENTITIES\n" +
    Array.from(
      { length: 2000 },
      (_, i) => `0\nLINE\n8\n0\n10\n${i}\n20\n0\n11\n${i}\n21\n100\n`,
    ).join("") +
    "0\nLINE\n8\n0\n10\n-10\n20\n25\n11\n2100\n21\n25\n0\nLINE\n8\n0\n10\n-10\n20\n75\n11\n2100\n21\n75\n0\nENDSEC\n0\nEOF\n";
  s.load_dxf(new TextEncoder().encode(text));
  for (let i = 0; i < 100; i++)
    s.execute(
      "spline",
      JSON.stringify({
        fit: [
          [5000 + i, 0],
          [5001 + i, 40],
          [5003 + i, 0],
        ],
      }),
    );
  const run = (c, p) => s.execute(c, JSON.stringify(p));
  const p = {
    fence: [
      [-1, 50],
      [50.5, 50],
    ],
    mode: "quick",
  };
  let t = performance.now();
  const preview = JSON.parse(
    run("bridge.preview_modify", { command: "trim", params: p, compact: true }),
  );
  const previewMs = performance.now() - t;
  t = performance.now();
  run("trim", p);
  const commitMs = performance.now() - t;
  console.log(
    JSON.stringify({
      entities: 2102,
      targets: 51,
      previewMs,
      commitMs,
      primitives: preview.primitives.length,
    }),
  );
} finally {
  s.free();
}

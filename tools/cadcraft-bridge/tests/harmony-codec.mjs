import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = new URL("../../../resources/cadcraft/harmony/", import.meta.url);
const javascript = await readFile(new URL("cadcraft-codec.js", directory), "utf8");
const codec = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);
codec.initSync({ module: await readFile(new URL("cadcraft-codec_bg.wasm", directory)) });
const fontPath = `${root}src/shared/document/fonts/SourceHanSerifCN-Regular.otf`;
const font = await readFile(fontPath);
const session = new codec.CadcraftSession();
session.register_font("Source Han Serif CN", font);
session.execute(
  "line",
  JSON.stringify({
    points: [
      [0, 0],
      [20, 10],
    ],
  }),
);
session.execute("circle", JSON.stringify({ center: [30, 30], radius: 10 }));
const input = session.export_dxf();
session.free();
const convert = (operation, bytes = input, args = []) =>
  codec.convert_cad(operation, bytes, JSON.stringify(args), font);
const native = (operation, bytes, args = []) =>
  execFileSync(
    `${root}resources/cadcraft/cadcraft-codec`,
    [operation, "--font", fontPath, ...args],
    { input: bytes, maxBuffer: 100 * 1024 * 1024 },
  );

function compareScene(actual, expected) {
  if (typeof actual === "number" && typeof expected === "number") {
    // Native libm and WASM sin/cos may differ in their last floating-point bits.
    assert.ok(Math.abs(actual - expected) <= 1e-10, `${actual} differs from ${expected}`);
  } else if (actual !== null && typeof actual === "object") {
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    for (const key of Object.keys(actual)) compareScene(actual[key], expected[key]);
  } else assert.deepEqual(actual, expected);
}

test("Harmony and desktop preserve scene geometry and identical framed patent SVG", () => {
  compareScene(
    JSON.parse(Buffer.from(convert("dxf-to-scene")).toString()),
    JSON.parse(native("dxf-to-scene", input).toString()),
  );
  for (const args of [[], ["--patent-preview", "--frame", "-10", "60", "80", "90"]])
    assert.deepEqual(
      Buffer.from(convert("dxf-to-svg", input, args)),
      native("dxf-to-svg", input, args),
    );
});

test("DWG write/read preserves the same entities through native and WASM codecs", () => {
  const dwg = convert("dxf-to-dwg");
  assert.match(Buffer.from(dwg).subarray(0, 6).toString(), /^AC10\d\d$/u);
  const dxf = convert("dwg-to-dxf", dwg);
  assert.deepEqual(Buffer.from(dxf), native("dwg-to-dxf", dwg));
  const scene = JSON.parse(Buffer.from(convert("dxf-to-scene", dxf)).toString());
  assert.equal(scene.entityCount, 2);
  const nativeDwg = native("dxf-to-dwg", input);
  assert.deepEqual(
    JSON.parse(Buffer.from(convert("dxf-to-scene", convert("dwg-to-dxf", nativeDwg))).toString()),
    scene,
  );
});

test("malformed data, invalid operation and invalid frame fail instead of yielding a drawing", () => {
  for (const [operation, bytes, args] of [
    ["dwg-to-dxf", new Uint8Array([1, 2, 3]), []],
    ["unknown", input, []],
    ["dxf-to-svg", input, ["--frame", "0", "1", "-1", "2"]],
    ["dxf-to-svg", input, ["--frame", "NaN", "1", "2", "2"]],
    ["dxf-to-dwg", new Uint8Array(), []],
  ])
    assert.throws(() => convert(operation, bytes, args));
});

test("the shipped worker executes real WASM and retains ownership of input bytes", async () => {
  const before = Uint8Array.from(input);
  const worker = new Worker(new URL("worker.mjs", directory), {
    workerData: {
      root: `${root}resources/cadcraft`,
      operation: "dxf-to-scene",
      bytes: input,
      fontPath,
      args: [],
    },
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Worker exited before result (${code})`)));
    });
    assert.equal(JSON.parse(Buffer.from(result.bytes).toString()).entityCount, 2);
    assert.deepEqual(input, before);
  } finally {
    await worker.terminate();
  }
});

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = readFileSync(join(__dirname, "sharp-adapted.cjs"), "utf8");
function load(webAssembly, sharp) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    __dirname,
    Buffer,
    Uint8Array,
    WebAssembly: webAssembly,
    require(name) {
      if (name === "sharp") return sharp();
      return require(name);
    },
  });
  return module.exports;
}

test("without WebAssembly, the adapter initializes and image processing fails explicitly", async () => {
  const adapter = load(undefined, () => {
    throw new Error("WebAssembly is not defined");
  });
  await adapter.initialize();
  const input = Buffer.from("source image must remain intact");
  const before = Buffer.from(input);
  assert.throws(() => adapter(input), /当前运行环境.*WebAssembly/u);
  assert.deepEqual(input, before);
  assert.throws(() => adapter(), /当前运行环境.*WebAssembly/u);
});

test("available WebAssembly preserves ordinary image options and sharp helpers", () => {
  const output = { metadata: async () => ({ width: 1, height: 1 }) };
  const input = Buffer.from("image");
  const options = { failOn: "error" };
  const sharp = Object.assign(
    (data, config) => {
      assert.equal(data, input);
      assert.equal(config, options);
      return output;
    },
    { versions: { test: "1" } },
  );
  const adapter = load(WebAssembly, () => sharp);
  assert.equal(adapter(input, options), output);
  assert.equal(adapter.versions, sharp.versions);
});

test("ordinary dependency failures remain visible instead of being treated as restricted mode", () => {
  assert.throws(
    () =>
      load(WebAssembly, () => {
        throw new Error("broken image dependency");
      }),
    /broken image dependency/u,
  );
});

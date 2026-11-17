import { readFile, writeFile } from "node:fs/promises";

// acadrust 0.6.3 already has a byte-stream WASM implementation. Enable it only
// for the dedicated codec build; the regular browser editor keeps its stubs.
const directory = new URL(
  "../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/dwg/",
  import.meta.url,
);
const manifestPath = new URL("Cargo.toml", directory);
const manifest = await readFile(manifestPath, "utf8");
if (!manifest.includes("[features]")) {
  if (!manifest.includes("[target.'cfg(not(target_arch = \"wasm32\"))'.dependencies]"))
    throw new Error("Unexpected pinned DWG manifest");
  await writeFile(
    manifestPath,
    `${manifest}
[features]
wasm-codec = ["dep:acadrust"]

[target.'cfg(target_arch = "wasm32")'.dependencies]
acadrust = { version = "0.6.3", optional = true }
`,
  );
}
const sourcePath = new URL("src/lib.rs", directory);
let source = await readFile(sourcePath, "utf8");
if (!source.includes('feature = "wasm-codec"')) {
  if (
    source.split('#[cfg(not(target_arch = "wasm32"))]').length !== 3 ||
    source.split('#[cfg(target_arch = "wasm32")]').length !== 5
  )
    throw new Error("Unexpected pinned DWG implementation");
  source = source
    .replaceAll(
      '#[cfg(not(target_arch = "wasm32"))]',
      '#[cfg(any(not(target_arch = "wasm32"), feature = "wasm-codec"))]',
    )
    .replaceAll(
      '#[cfg(target_arch = "wasm32")]',
      '#[cfg(all(target_arch = "wasm32", not(feature = "wasm-codec")))]',
    );
  await writeFile(sourcePath, source);
}

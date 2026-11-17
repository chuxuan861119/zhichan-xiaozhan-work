import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [output, archive] = process.argv.slice(2);
if (!output || !archive)
  throw new Error("Usage: build-harmony-tools.mjs <output.node> <official-napi.zip>");
const native =
  process.env.HARMONY_NATIVE_SDK ??
  "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native";
const compiler = join(native, "llvm/bin/clang");
await stat(compiler);
const scratch = await mkdtemp(join(tmpdir(), "zxw-harmony-napi-"));
const required = new Map([
  ...["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"].map((name) => [
    `electron-napi-library/include/electron_node/src/${name}`,
    name,
  ]),
  ["electron-napi-library/lib/libshim.a", "libshim.a"],
]);
const zip = await new Promise((ok, fail) =>
  yauzl.open(archive, { lazyEntries: true }, (error, value) => (error ? fail(error) : ok(value))),
);
await new Promise((ok, fail) => {
  zip.on("error", fail);
  zip.on("end", () =>
    required.size ? fail(new Error("Official NAPI resources are missing")) : ok(),
  );
  zip.on("entry", (entry) => {
    const name = required.get(entry.fileName);
    if (!name) return zip.readEntry();
    if (entry.uncompressedSize > 200000) return fail(new Error("Oversized NAPI resource"));
    zip.openReadStream(entry, (error, stream) => {
      if (error) return fail(error);
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", fail);
      stream.on("end", async () => {
        try {
          await writeFile(join(scratch, name), Buffer.concat(chunks));
          required.delete(entry.fileName);
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      });
    });
  });
  zip.readEntry();
});
const shim = join(scratch, "libshim.a");
if (
  createHash("sha256")
    .update(await readFile(shim))
    .digest("hex") !== "6c8b3134b858c505b1741fd182f921dd092774558addabc8848d71287edf5d52"
)
  throw new Error("Unexpected Electron NAPI shim");
await mkdir(dirname(resolve(output)), { recursive: true });
const result = spawnSync(
  compiler,
  [
    "--target=aarch64-linux-ohos",
    `--sysroot=${join(native, "sysroot")}`,
    "-fPIC",
    "-shared",
    "-DNAPI_VERSION=8",
    '-DNAPI_EXTERN=__attribute__((visibility("hidden")))',
    "-fvisibility=hidden",
    `-I${scratch}`,
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    join(root, "tools/platform/harmony-move.c"),
    shim,
    "-ldl",
    "-Wl,-z,defs",
    "-Wl,--exclude-libs,ALL",
    "-o",
    resolve(output),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Harmony atomic file addon build failed");
console.log(`Harmony in-process atomic move addon ready: ${basename(output)}`);

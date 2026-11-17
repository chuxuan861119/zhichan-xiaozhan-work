import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Dependencies are installed separately with --ignore-scripts. No global changes.
const [sdkArg, dependenciesArg, headersArg, shimArg, outputArg] = process.argv.slice(2);
if (!outputArg)
  throw new Error(
    "Usage: node build-sqlite.mjs <SDK-native> <node_modules> <Node-headers> <libshim.a> <new-output>",
  );
const [sdk, dependencies, headers, shim, output] = [
  sdkArg,
  dependenciesArg,
  headersArg,
  shimArg,
  outputArg,
].map((value) => resolve(value));
const source = join(dependencies, "better-sqlite3");
if (JSON.parse(readFileSync(join(source, "package.json"))).version !== "13.0.3")
  throw new Error("Expected better-sqlite3 13.0.3");
const shimHash = createHash("sha256").update(readFileSync(shim)).digest("hex");
if (shimHash !== "6c8b3134b858c505b1741fd182f921dd092774558addabc8848d71287edf5d52")
  throw new Error("Unexpected Electron NAPI shim");
mkdirSync(output);
const defines = readFileSync(join(source, "deps/defines.gypi"), "utf8")
  .match(/'([A-Z][A-Z0-9_]*(?:=[^']*)?)'/g)
  .map((value) => `-D${value.slice(1, -1)}`);
const common = [
  "--target=aarch64-linux-ohos",
  `--sysroot=${join(sdk, "sysroot")}`,
  "-fPIC",
  "-O2",
  "-DNDEBUG",
];
function run(tool, args) {
  execFileSync(join(sdk, "llvm/bin", tool), args, { stdio: "inherit" });
}
run("clang", [
  ...common,
  ...defines,
  "-c",
  join(source, "deps/sqlite3/sqlite3.c"),
  "-o",
  join(output, "sqlite3.o"),
]);
run("clang++", [
  ...common,
  "-std=c++20",
  "-DNAPI_VERSION=10",
  "-DNAPI_DISABLE_CPP_EXCEPTIONS",
  "-DNODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS",
  '-DNAPI_EXTERN=__attribute__((visibility("hidden")))',
  "-fvisibility=hidden",
  `-I${headers}`,
  `-I${join(dependencies, "node-addon-api")}`,
  `-I${join(source, "deps/sqlite3")}`,
  "-c",
  join(source, "src/better_sqlite3.cpp"),
  "-o",
  join(output, "better_sqlite3.o"),
]);
// Keep the C++ runtime private to this NAPI addon; do not depend on a missing
// libc++_shared.so or interpose Harmony's Ark NAPI implementation.
run("clang++", [
  ...common,
  "-shared",
  "-static-libstdc++",
  "-Wl,-z,defs",
  "-Wl,--exclude-libs,ALL",
  join(output, "better_sqlite3.o"),
  join(output, "sqlite3.o"),
  shim,
  "-ldl",
  "-o",
  join(output, "better_sqlite3.node"),
]);
run("llvm-readelf", ["-d", join(output, "better_sqlite3.node")]);

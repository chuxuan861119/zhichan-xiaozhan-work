import assert from "node:assert/strict";
import test from "node:test";
import {
  configureFileOpening,
  configureProductLabels,
  configureProductPermissions,
  configureRuntimeBuild,
  parseHarmonyConfig,
  patchFileWant,
  patchNativeLogPrivacy,
  patchPickerAccess,
  patchUsageActivityBinding,
} from "./harmony-platform-adapters.mjs";

test("release runtime preserves native bridge ABI without changing release or debug configuration", () => {
  const original = {
    apiType: "stageMode",
    buildOptionSet: [
      {
        name: "release",
        arkOptions: {
          obfuscation: { ruleOptions: { enable: true, files: ["./obfuscation-rules.txt"] } },
        },
      },
      { name: "debug", arkOptions: { debugInfo: true } },
    ],
    targets: [{ name: "default" }],
  };
  const result = configureRuntimeBuild(original);
  assert.equal(result.buildOptionSet[0].arkOptions.obfuscation.ruleOptions.enable, false);
  assert.equal(original.buildOptionSet[0].arkOptions.obfuscation.ruleOptions.enable, true);
  assert.deepEqual(result.buildOptionSet[1], original.buildOptionSet[1]);
  assert.deepEqual(result.targets, original.targets);
  assert.deepEqual(configureRuntimeBuild(result), result);
  assert.throws(() => configureRuntimeBuild({}), /Unsupported Harmony runtime/);
});

test("native usage binding is fixed and idempotent", () => {
  const source =
    "import JsBindingUtils from '../utils/JsBindingUtils';\nclass Bind {\n  static bind() {\n  }\n}";
  const result = patchUsageActivityBinding(source);
  assert.match(result, /Workbench.ReadUsageActivity/);
  assert.match(result, /adapter\/WorkbenchUsageActivity/);
  assert.equal(patchUsageActivityBinding(result), result);
});

test("the shipped ArkTS activity reader fails closed on native lock/display errors", async () => {
  const { readFile } = await import("node:fs/promises");
  const { transformSync } = await import("esbuild");
  const source = await readFile(
    new URL("../platforms/harmony/arkts/WorkbenchUsageActivity.ets", import.meta.url),
    "utf8",
  );
  const code = transformSync(source.replace(/^import .*;\r?\n/gm, ""), {
    loader: "ts",
    format: "cjs",
  }).code;
  let locked = false,
    active = true,
    fail = false;
  const native = {
    isScreenLocked: async () => {
      if (fail) throw Error("native");
      return locked;
    },
  };
  const power = { isActive: () => active };
  const module = { exports: {} };
  new Function("screenLock", "power", "module", "exports", code)(
    native,
    power,
    module,
    module.exports,
  );
  const read = () =>
    new Promise((resolve) =>
      module.exports.readUsageActivity((value) => resolve(JSON.parse(value))),
    );
  assert.deepEqual(await read(), { active: true, locked: false });
  locked = true;
  assert.deepEqual(await read(), { active: true, locked: true });
  active = false;
  assert.deepEqual(await read(), { active: false, locked: true });
  fail = true;
  assert.deepEqual(await read(), {});
});

test("localized permission dialogs identify the actual product rather than Electron", () => {
  const input = {
    string: [
      { name: "EntryAbility_label", value: "Electron" },
      { name: "button_ok", value: "确定" },
    ],
  };
  const result = configureProductLabels(input);
  assert.equal(result.string[0].value, "知产小栈Work");
  assert.equal(result.string[1].value, "确定");
  assert.equal(input.string[0].value, "Electron");
});

test("runtime logging keeps categories while sensitive native message contents are private", () => {
  const source = Array(4).fill("tag: %{public}s --> %{public}s").join("\n");
  const result = patchNativeLogPrivacy(source);
  assert.equal(result.includes("--> %{public}s"), false);
  assert.equal(result.split("--> %{private}s").length, 5);
  assert.equal(patchNativeLogPrivacy(result), result);
  assert.throws(() => patchNativeLogPrivacy("changed template"), /Unsupported Harmony logging/u);
});

test("file association is limited to PATDOC and does not advertise cross-device document transfer", () => {
  const original = parseHarmonyConfig(
    "{module:{abilities:[{name:'EntryAbility',continuable:true,skills:[{actions:['home'],uris:[]},],}],},}",
  );
  const { config, utd } = configureFileOpening(original, "com.example.work");
  const entry = config.module.abilities[0];
  assert.equal(entry.continuable, false);
  assert.deepEqual(entry.skills[0].actions, ["home"]);
  assert.deepEqual(
    entry.skills[1].uris.map((uri) => uri.type),
    ["com.example.work.patdoc", "application/vnd.zhichan.patdoc"],
  );
  assert.deepEqual(utd.UniformDataTypeDeclarations[0].FilenameExtensions, [".patdoc"]);
  assert.equal(original.module.abilities[0].continuable, true);
  assert.deepEqual(configureFileOpening(config, "com.example.work").config, config);
});

test("permission profile removes unused sensitive features and retains file, clipboard, printing and runtime requirements", () => {
  const names = [
    "CAMERA",
    "MICROPHONE",
    "LOCATION",
    "SYSTEM_FLOAT_WINDOW",
    "READ_PASTEBOARD",
    "FILE_ACCESS_PERSIST",
    "PRINT",
    "kernel.ALLOW_WRITABLE_CODE_MEMORY",
  ];
  const original = {
    module: {
      requestPermissions: names.map((name) => ({
        name: "ohos.permission." + name,
        usedScene: { abilities: ["FormAbility"], when: "always" },
      })),
    },
  };
  const result = configureProductPermissions(original);
  assert.deepEqual(
    result.module.requestPermissions.map((item) => item.name),
    names.slice(4).map((name) => "ohos.permission." + name),
  );
  assert.deepEqual(result.module.requestPermissions[0].usedScene, {
    abilities: ["EntryAbility"],
    when: "inuse",
  });
  assert.equal(original.module.requestPermissions.length, names.length);
});

test("cold and warm file requests reach shared validation while adapter changes fail closed", () => {
  const source = "    super.onCreate(want, launchParam);\n  onDestroy() {";
  const result = patchFileWant(source);
  assert.match(result, /parameters\['cmdArgs'\] = \[want.uri\]/u);
  assert.match(result, /zhichan-patdoc:\/\/open\?uri=/u);
  assert.match(result, /want.uri = ''/u);
  assert.equal(patchFileWant(result), result);
  assert.throws(() => patchFileWant("unsupported template"), /Unsupported Harmony adapter/u);
  assert.throws(() => patchPickerAccess("unsupported template"), /Unsupported Harmony adapter/u);
});

test("only actual Harmony boot launches request tray startup, preserving file and manual launches", async () => {
  const { transformSync } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const source = `class Entry extends Base {
    onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
      super.onCreate(want, launchParam);
    }
    onDestroy() {}
  }
  globalThis.Entry = Entry;`;
  const patched = patchFileWant(source);
  const sandbox = {
    Base: class {
      onCreate(want) {
        this.want = want;
      }
    },
    AbilityConstant: { LaunchReason: { AUTO_STARTUP: 8 } },
  };
  runInNewContext(transformSync(patched, { loader: "ts" }).code, sandbox);
  const invoke = (want, launchReason) => {
    const instance = new sandbox.Entry();
    instance.onCreate(want, { launchReason });
    return instance.want;
  };
  assert.deepEqual(Array.from(invoke({}, 8).parameters.cmdArgs), ["--startup-to-tray"]);
  assert.equal(invoke({}, 1).parameters, undefined);
  assert.equal(invoke({}, 4).parameters, undefined);
  assert.deepEqual(
    Array.from(
      invoke({ parameters: { cmdArgs: ["--startup-to-tray", "existing"] } }, 8).parameters.cmdArgs,
    ),
    ["existing", "--startup-to-tray"],
  );
  const file = invoke({ uri: "file://docs/example.patdoc" }, 8);
  assert.deepEqual(Array.from(file.parameters.cmdArgs), [
    "file://docs/example.patdoc",
    "--startup-to-tray",
  ]);
  assert.equal(file.uri, "");
});

test("save picker avoids invalid empty PATDOC placeholders and retains a bare suggested filename", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../platforms/harmony/arkts/WorkbenchFileAccess.ets", import.meta.url),
    "utf8",
  );
  const adapters = await fs.readFile(
    new URL("./harmony-platform-adapters.mjs", import.meta.url),
    "utf8",
  );
  assert.match(adapters, /DocumentSaveOptions\.autoCreateEmptyFile = false/u);
  assert.match(adapters, /dirAndFile\[1\] = default_path\.trim\(\)/u);
  assert.match(source, /ensureSaveDirectoryAccess/u);
});

test("existing public files get a new numbered URI while private paths and fresh public names stay unchanged", async () => {
  const { buildSync } = await import("esbuild");
  const { fileURLToPath } = await import("node:url");
  const compiled = buildSync({
    entryPoints: [
      fileURLToPath(new URL("../platforms/harmony/arkts/save-destination.ts", import.meta.url)),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", compiled.outputFiles[0].text)(module, module.exports);
  const uri = "file://docs/storage/Users/currentUser/Download/%E6%B5%8B%E8%AF%95.patdoc";
  const files = new Set([
    "/storage/Users/currentUser/Download/测试.patdoc",
    "/storage/Users/currentUser/Download/测试 (1).patdoc",
  ]);
  const exists = (path) => files.has(path);
  assert.deepEqual(module.exports.resolveSaveDestination(uri, exists), {
    uri: "file://docs/storage/Users/currentUser/Download/%E6%B5%8B%E8%AF%95%20(2).patdoc",
    copyName: "测试 (2).patdoc",
  });
  const fresh = "file://docs/storage/Users/currentUser/Download/new.pdf";
  assert.deepEqual(module.exports.resolveSaveDestination(fresh, exists), {
    uri: fresh,
    copyName: "",
  });
  const privateUri = "file://com.example/private/existing.pdf";
  assert.deepEqual(
    module.exports.resolveSaveDestination(privateUri, () => true),
    { uri: privateUri, copyName: "" },
  );
  assert.throws(() => module.exports.resolveSaveDestination(uri, () => true), /无法找到/u);
});

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import JSON5 from "json5";

function replaceOnce(source, anchor, replacement) {
  if (source.includes(replacement)) return source;
  if (source.split(anchor).length !== 2) throw new Error(`Unsupported Harmony adapter: ${anchor}`);
  return source.replace(anchor, replacement);
}

export function patchUsageActivityBinding(source) {
  source = replaceOnce(
    source,
    "import JsBindingUtils from '../utils/JsBindingUtils';",
    "import { readUsageActivity } from '../adapter/WorkbenchUsageActivity';\nimport JsBindingUtils from '../utils/JsBindingUtils';",
  );
  return replaceOnce(
    source,
    "  static bind() {",
    "  static bind() {\n    JsBindingUtils.bindFunction('Workbench.ReadUsageActivity', readUsageActivity);",
  );
}

export function parseHarmonyConfig(source) {
  return JSON5.parse(source);
}

export function configureRuntimeBuild(config) {
  const result = structuredClone(config);
  const release = result.buildOptionSet?.find((option) => option.name === "release");
  const rules = release?.arkOptions?.obfuscation?.ruleOptions;
  if (!rules) throw new Error("Unsupported Harmony runtime release obfuscation configuration");
  // Native exports and string-based bridge callbacks are an ABI. The supplied
  // runtime has no complete keep rules: renaming getNativeContext alone crashes
  // before the app starts. Keep the vendor ArkTS bridge names in release builds.
  // This does not change release mode, signing, app debug flags or JS bundling.
  rules.enable = false;
  return result;
}

export function configureProductLabels(config) {
  const result = structuredClone(config);
  for (const item of result.string) {
    if (["app_name", "EntryAbility_label", "StatusBarEntryAbility_label"].includes(item.name))
      item.value = "知产小栈Work";
  }
  return result;
}

// This offline drafting product has no location, recording, screen capture,
// device sensors, browser extensions or cross-device sync features.
export function configureProductPermissions(config) {
  const result = structuredClone(config);
  const unused = new Set(
    [
      "DISTRIBUTED_DATASYNC",
      "GYROSCOPE",
      "ACCELEROMETER",
      "LOCATION",
      "APPROXIMATELY_LOCATION",
      "LOCATION_IN_BACKGROUND",
      "MICROPHONE",
      "CAMERA",
      "ACCESS_BLUETOOTH",
      "CUSTOM_SCREEN_CAPTURE",
      "WEB_NATIVE_MESSAGING",
      // Product BrowserWindows use MAIN_WINDOW, never the opt-in FLOAT_WINDOW.
      // Ordinary always-on-top windows do not require a system floating window.
      "SYSTEM_FLOAT_WINDOW",
    ].map((name) => `ohos.permission.${name}`),
  );
  result.module.requestPermissions = result.module.requestPermissions.filter(
    (item) => !unused.has(item.name),
  );
  for (const item of result.module.requestPermissions) {
    if (item.usedScene) item.usedScene = { abilities: ["EntryAbility"], when: "inuse" };
  }
  return result;
}

export function configureFileOpening(config, bundleName) {
  const result = structuredClone(config);
  const entry = result.module.abilities.find((item) => item.name === "EntryAbility");
  if (!entry) throw new Error("Missing Harmony EntryAbility");
  const type = `${bundleName}.patdoc`;
  entry.skills = entry.skills.filter(
    (skill) => !skill.uris?.some((uri) => uri.linkFeature === "FileOpen"),
  );
  entry.skills.push({
    actions: ["ohos.want.action.viewData"],
    uris: [
      { scheme: "file", type, linkFeature: "FileOpen" },
      { scheme: "file", type: "application/vnd.zhichan.patdoc", linkFeature: "FileOpen" },
    ],
  });
  entry.continuable = false; // No cross-device library transfer is implemented.
  return {
    config: result,
    utd: {
      UniformDataTypeDeclarations: [
        {
          TypeId: type,
          BelongingToTypes: ["general.composite-object"],
          FilenameExtensions: [".patdoc"],
          MIMETypes: ["application/vnd.zhichan.patdoc"],
          Description: "知产小栈专利文档",
          ReferenceURL: "",
        },
      ],
    },
  };
}

export function patchFileWant(source) {
  source = replaceOnce(
    source,
    "    super.onCreate(want, launchParam);",
    [
      "    // ZXW: file requests enter shared validation, never Chromium navigation.",
      "    if (want.uri?.startsWith('file://')) {",
      "      const parameters = want.parameters ?? {};",
      "      parameters['cmdArgs'] = [want.uri];",
      "      want.parameters = parameters;",
      "      want.uri = '';",
      "    }",
      "    if (launchParam.launchReason === AbilityConstant.LaunchReason.AUTO_STARTUP) {",
      "      const parameters = want.parameters ?? {};",
      "      const args = (parameters['cmdArgs'] as string[] | undefined) ?? [];",
      "      parameters['cmdArgs'] = args.filter((arg: string) => arg !== '--startup-to-tray').concat(['--startup-to-tray']);",
      "      want.parameters = parameters;",
      "    }",
      "    super.onCreate(want, launchParam);",
    ].join("\n"),
  );
  return replaceOnce(
    source,
    "  onDestroy() {",
    [
      "  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {",
      "    if (want.uri?.startsWith('file://')) {",
      "      want.uri = 'zhichan-patdoc://open?uri=' + encodeURIComponent(want.uri);",
      "    }",
      "    super.onNewWant(want, launchParam);",
      "  }",
      "",
      "  onDestroy() {",
    ].join("\n"),
  );
}

export function patchPickerAccess(source) {
  source = replaceOnce(
    source,
    "    let DocumentSaveOptions = new picker.DocumentSaveOptions();",
    "    let DocumentSaveOptions = new picker.DocumentSaveOptions();\n    DocumentSaveOptions.autoCreateEmptyFile = false;",
  );
  source = replaceOnce(
    source,
    "    let dirAndFile: string[] = [DialogAdapter.DEFAULT_DIR, ''];",
    [
      "    let dirAndFile: string[] = [DialogAdapter.DEFAULT_DIR, ''];",
      "    if (default_path && !default_path.includes('/') && !default_path.includes('\\\\')) {",
      "      dirAndFile[1] = default_path.trim();",
      "      return dirAndFile;",
      "    }",
    ].join("\n"),
  );
  source = replaceOnce(
    source,
    "import { fileUri } from '@kit.CoreFileKit';",
    "import { persistSelectedAccess, ensureSaveDirectoryAccess } from './WorkbenchFileAccess';\nimport { resolveSaveDestination } from './save-destination';\nimport { fileUri } from '@kit.CoreFileKit';",
  );
  source = replaceOnce(
    source,
    "documentPicker.select(DocumentSelectOptions).then((DocumentSelectResult: Array<string>) => {",
    "documentPicker.select(DocumentSelectOptions).then(async (DocumentSelectResult: Array<string>) => {",
  );
  source = replaceOnce(
    source,
    "        callback(DocumentSelectResult, false);",
    [
      "        try {",
      "          const directory = Boolean(dialogSettings.properties_open_directory);",
      "          await persistSelectedAccess(DocumentSelectResult, directory, directory);",
      "        } catch {",
      "          this.showErrorBox('文件授权失败', '未能取得所选文件的持久访问权限。请重新选择文件，或在系统设置中检查文件权限。现有文档未被修改。', () => callback([], true));",
      "          return;",
      "        }",
      "        callback(DocumentSelectResult, false);",
    ].join("\n"),
  );
  source = replaceOnce(
    source,
    "documentPicker.save(DocumentSaveOptions).then((DocumentSaveResult: Array<string>) => {",
    "documentPicker.save(DocumentSaveOptions).then(async (DocumentSaveResult: Array<string>) => {",
  );
  return replaceOnce(
    source,
    "        callback(DocumentSaveResult[0], false);",
    [
      "        try {",
      "          if (!await ensureSaveDirectoryAccess(DocumentSaveResult[0])) { callback('', true); return; }",
      "          const destination = resolveSaveDestination(DocumentSaveResult[0], (path: string): boolean => fs.accessSync(path));",
      "          const savedPath = destination.uri.startsWith('file://docs/') ? decodeURIComponent(destination.uri.slice('file://docs'.length)) : destination.uri;",
      "          if (fs.accessSync(savedPath)) {",
      "            await persistSelectedAccess([destination.uri], true);",
      "          }",
      "          if (destination.copyName) {",
      "            this.showErrorBox('另存为副本', '当前保存位置不支持安全覆盖，原文件保持不变。将另存为“' + destination.copyName + '”。', () => callback(destination.uri, false));",
      "            return;",
      "          }",
      "          callback(destination.uri, false);",
      "        } catch {",
      "          this.showErrorBox('保存位置授权失败', '未能取得所选位置的写入权限。请重新选择保存位置。现有文档未被修改。', () => callback('', true));",
      "          return;",
      "        }",
    ].join("\n"),
  );
}

export function patchNativeLogPrivacy(source) {
  if (!source.includes("--> %{public}s") && source.includes("--> %{private}s")) return source;
  if (source.split("--> %{public}s").length !== 5)
    throw new Error("Unsupported Harmony logging adapter");
  // Framework diagnostics can contain paths, clipboard content or credentials.
  // Keep tags public and let the OS redact message content by default.
  return source.replaceAll("--> %{public}s", "--> %{private}s");
}

export async function installPlatformAdapters(project, root, bundleName) {
  for (const module of ["electron", "web_engine"]) {
    const profile = join(project, module, "build-profile.json5");
    await writeFile(
      profile,
      JSON.stringify(
        configureRuntimeBuild(parseHarmonyConfig(await readFile(profile, "utf8"))),
        null,
        2,
      ),
    );
  }
  const resources = join(project, "electron/src/main/resources");
  for (const locale of await readdir(resources, { withFileTypes: true })) {
    if (!locale.isDirectory()) continue;
    const file = join(resources, locale.name, "element/string.json");
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await writeFile(
      file,
      JSON.stringify(configureProductLabels(parseHarmonyConfig(source)), null, 2),
    );
  }
  const entryPath = join(project, "electron/src/main/module.json5");
  const { config, utd } = configureFileOpening(
    parseHarmonyConfig(await readFile(entryPath, "utf8")),
    bundleName,
  );
  await writeFile(entryPath, JSON.stringify(config, null, 2));
  const utdPath = join(project, "electron/src/main/resources/rawfile/arkdata/utd/utd.json5");
  await mkdir(dirname(utdPath), { recursive: true });
  await writeFile(utdPath, JSON.stringify(utd, null, 2));
  const ets = join(project, "web_engine/src/main/ets");
  const log = join(ets, "utils/LogUtil.ts");
  await writeFile(log, patchNativeLogPrivacy(await readFile(log, "utf8")));
  const webModule = join(project, "web_engine/src/main/module.json5");
  await writeFile(
    webModule,
    JSON.stringify(
      configureProductPermissions(parseHarmonyConfig(await readFile(webModule, "utf8"))),
      null,
      2,
    ),
  );
  await copyFile(
    join(root, "platforms/harmony/arkts/WorkbenchFileAccess.ets"),
    join(ets, "adapter/WorkbenchFileAccess.ets"),
  );
  await copyFile(
    join(root, "platforms/harmony/arkts/save-destination.ts"),
    join(ets, "adapter/save-destination.ts"),
  );
  const entry = join(project, "electron/src/main/ets/entryability/EntryAbility.ets");
  await writeFile(entry, patchFileWant(await readFile(entry, "utf8")));
  const picker = join(ets, "adapter/DialogAdapter.ets");
  await writeFile(picker, patchPickerAccess(await readFile(picker, "utf8")));
  const binding = join(ets, "jsbindings/EtsBridgeAdapterBind.ets");
  await copyFile(
    join(root, "platforms/harmony/arkts/WorkbenchUsageActivity.ets"),
    join(ets, "adapter/WorkbenchUsageActivity.ets"),
  );
  let source = await readFile(binding, "utf8");
  source = replaceOnce(
    source,
    "import JsBindingUtils from '../utils/JsBindingUtils';",
    "import { restoreFileAccess, persistOpenedFile, readStartup, openStartupSettings } from '../adapter/WorkbenchFileAccess';\nimport JsBindingUtils from '../utils/JsBindingUtils';",
  );
  source = replaceOnce(
    source,
    "  static bind() {",
    "  static bind() {\n    JsBindingUtils.bindFunction('Workbench.RestoreFileAccess', restoreFileAccess);\n    JsBindingUtils.bindFunction('Workbench.PersistOpenedFile', persistOpenedFile);\n    JsBindingUtils.bindFunction('Workbench.ReadStartup', readStartup);\n    JsBindingUtils.bindFunction('Workbench.OpenStartupSettings', openStartupSettings);",
  );
  await writeFile(binding, patchUsageActivityBinding(source));
}

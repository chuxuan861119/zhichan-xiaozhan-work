import { readFile } from "node:fs/promises";
import sharp from "sharp";

test("excludes only duplicate chemical runtime packages, retaining bundled assets and license inputs", async () => {
  const config = await readFile("electron-builder.yml", "utf8");
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  for (const name of ["ketcher-core", "ketcher-react", "ketcher-standalone", "indigo-ketcher"]) {
    expect(config).toContain(`!node_modules/${name}/**`);
  }
  for (const name of ["ketcher-core", "ketcher-react", "ketcher-standalone"]) {
    expect(manifest.dependencies[name]).toBe("3.17.1");
  }
  for (const directory of ["main", "preload", "renderer"]) {
    expect(config).toContain(`- out/${directory}/**`);
  }
  expect(config).not.toContain("- out/**");
  expect(config).toContain("- from: resources");
  expect(config).not.toMatch(/!.*(?:out|resources)\//u);
});

test("keeps build inputs byte-stable on Windows checkouts", async () => {
  const attributes = await readFile(".gitattributes", "utf8");
  expect(attributes).toContain("* text=auto eol=lf");
  expect(attributes).toContain("*.png binary");
  expect(attributes).toContain("*.dll binary");
});

test("uses the supplied Xiaozhan logo for deterministic transparent app assets", async () => {
  const source = await sharp("build/logo-source.png").metadata();
  expect(source).toMatchObject({ format: "png", width: 1024, height: 1024 });
  const metadata = await sharp("build/icon.png").metadata();
  expect(metadata).toMatchObject({ format: "png", width: 512, height: 512, hasAlpha: true });
  const rendererLogo = await sharp("src/renderer/src/assets/xiaozhan-logo.png").metadata();
  expect(rendererLogo).toMatchObject({ format: "png", width: 512, height: 512, hasAlpha: true });
});

test("keeps the assisted Windows installer on its native visual style", async () => {
  const config = await readFile("electron-builder.yml", "utf8");
  expect(config).not.toContain("installerHeader:");

  const iconGenerator = await readFile("build/generate-icon.mjs", "utf8");
  expect(iconGenerator).not.toContain("installerHeader.bmp");
});

test("configures one unsigned per-user NSIS x64 installer and patdoc association", async () => {
  const config = await readFile("electron-builder.yml", "utf8");
  for (const required of [
    "appId: cn.local.zhichanxiaozhanwork",
    "productName: 知产小栈Work",
    "target: nsis",
    "- x64",
    "signExecutable: false",
    "oneClick: false",
    "deleteAppDataOnUninstall: false",
    "perMachine: false",
    "allowElevation: false",
    "createStartMenuShortcut: true",
    "createDesktopShortcut: false",
    "shortcutName: 知产小栈Work",
    "include: build/installer.nsh",
    "beforePack: build/prepare-package.cjs",
    "artifactName: zhichan-xiaozhan-work-$" +
      "{version}-$" +
      "{env.PATENT_BUILD_ID}-win-x64.$" +
      "{ext}",
    "- ext: patdoc",
    "role: Editor",
  ]) {
    expect(config).toContain(required);
  }
  expect(config).not.toContain("allowElevation: true");
  expect(config).not.toMatch(/certificate|publisher|signingHashAlgorithms/iu);

  const installerInclude = await readFile("build/installer.nsh", "utf8");
  expect(installerInclude).toContain("!macro customInstallMode");
  expect(installerInclude).toContain('StrCpy $isForceCurrentInstall "1"');
  expect(installerInclude).toContain('!define MUI_PAGE_HEADER_TEXT "选择安装位置"');
  expect(installerInclude).toContain(
    '!define MUI_PAGE_HEADER_SUBTEXT "选择知产小栈Work的安装文件夹"',
  );
  expect(installerInclude).toContain(
    '!define MUI_DIRECTORYPAGE_TEXT_TOP "应用将安装到以下文件夹。"',
  );
  expect(installerInclude).toContain('!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装位置"');
  expect(installerInclude).toContain("Function UpdateInstallerBackButton");
  expect(installerInclude).toContain("$" + "{NSD_CreateTimer} UpdateInstallerBackButton 50");
  const installMode = installerInclude.match(/!macro customInstallMode(?<body>[\s\S]*?)!macroend/u)
    ?.groups?.body;
  const init = installerInclude.match(/!macro customInit(?<body>[\s\S]*?)!macroend/u)?.groups?.body;
  expect(installMode).toContain("$" + "{NSD_CreateTimer} UpdateInstallerBackButton 50");
  expect(installMode).toContain("Call UpdateInstallerBackButton");
  expect(init).not.toContain("NSD_CreateTimer");
  expect(installerInclude).toContain("EnableWindow $InstallerBackButton 0");
  expect(installerInclude).toContain("EnableWindow $InstallerBackButton 1");
  expect(installerInclude).not.toContain("SetFont");
  expect(installerInclude).toContain("!macro customPageAfterChangeDir");
  expect(installerInclude).toContain("!macro customInit");
  expect(installerInclude).toContain("创建桌面快捷方式");
  expect(installerInclude).toContain(
    '!insertmacro MUI_HEADER_TEXT "创建桌面快捷方式" "选择是否在桌面创建应用入口"',
  );
  expect(installerInclude).toContain("$" + "{NSD_Check} $DesktopShortcutCheckbox");
  expect(installerInclude).toContain('StrCpy $CreateDesktopShortcut "true"');
  expect(installerInclude).toContain("!macro customInstall");
  expect(installerInclude).toContain('CreateShortCut "$DESKTOP\\$' + '{SHORTCUT_NAME}.lnk"');
  expect(installerInclude).toContain("!macro customUnInstall");
  expect(installerInclude).toContain('Delete "$DESKTOP\\知产小栈Work.lnk"');
});

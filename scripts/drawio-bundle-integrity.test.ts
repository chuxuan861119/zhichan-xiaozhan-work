import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "@babel/parser";
import { afterEach, describe, expect, it } from "vitest";

import { auditDrawioBundle } from "./audit-drawio-bundle.mjs";
import { auditLicenses } from "./audit-licenses.mjs";
import { allowedAppPaths, CIRCUIT_RUNTIME_FILES, DRAWIO_POLICY } from "./drawio-bundle-policy.mjs";
import {
  buildDrawioTooltipLabels,
  buildPatentLocalizationBootstrap,
  createManifest,
  DRAWIO_ADAPTER_SOURCE,
  DRAWIO_EMBED_BRIDGE_SOURCE,
  DRAWIO_LICENSE_HASH,
  DRAWIO_MODIFICATION_NOTICE,
  DRAWIO_POPUP_SURFACE_CSS,
  DRAWIO_UI_LABELS,
  PATENT_ADVANCED_MENU_ITEMS,
  PATENT_CIRCUIT_LIBRARY_ENTRIES,
  PATENT_DEFAULT_LIBRARY_ENTRIES,
  PATENT_HIDDEN_LIBRARY_ENTRIES,
  PATENT_HIDDEN_MENU_ITEMS,
  PRESERVED_LOCALIZATION_TOKENS,
  parseDrawioOverrides,
  parseDrawioToolLabels,
  projectGitProxyArgs,
  publishDrawioBundle,
  sanitizeDrawioIndexHtml,
  sanitizeDrawioRuntime,
  validateDrawioOverrides,
  verifyPinnedUpstream,
} from "./vendor-drawio.mjs";

it("keeps flowchart popup shadow styles synchronized with their generator", async () => {
  const css = await readFile("resources/drawio/app/patent-toolbar.css", "utf8");
  expect(css.endsWith(DRAWIO_POPUP_SURFACE_CSS)).toBe(true);
});

const DEFAULT_PALETTE_FUNCTIONS = new Set([
  "addAdvancedPalette",
  "addBasicPalette",
  "addErPalette",
  "addElectricalPalette",
  "addGeneralPalette",
  "addIos7Palette",
  "addIosPalette",
  "addMiscPalette",
  "addUmlPalette",
]);
const TOOL_LABEL_ARGUMENTS = new Map([
  ["addDataEntry", 3],
  ["createEdgeTemplateEntry", 4],
  ["createEdgeTemplateFromCells", 3],
  ["createVertexTemplateEntry", 4],
  ["createVertexTemplateFromCells", 3],
]);

function collectDefaultPaletteToolLabels(source: string): string[] {
  const labels = new Set<string>();
  const visit = (node: unknown, paletteFunction: string | null = null): void => {
    if (node == null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    let activeFunction = paletteFunction;
    if (record.type === "AssignmentExpression") {
      const left = record.left as Record<string, unknown> | undefined;
      const property = left?.property as Record<string, unknown> | undefined;
      if (property?.type === "Identifier" && DEFAULT_PALETTE_FUNCTIONS.has(String(property.name))) {
        activeFunction = String(property.name);
      }
    }
    if (activeFunction && record.type === "CallExpression") {
      const callee = record.callee as Record<string, unknown> | undefined;
      const property = callee?.property as Record<string, unknown> | undefined;
      const name = property?.type === "Identifier" ? String(property.name) : null;
      const labelIndex = name ? TOOL_LABEL_ARGUMENTS.get(name) : undefined;
      const argument =
        labelIndex == null
          ? undefined
          : (record.arguments as Array<Record<string, unknown>> | undefined)?.[labelIndex];
      if (argument?.type === "StringLiteral" && typeof argument.value === "string") {
        labels.add(argument.value);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === "loc" || key === "extra") continue;
      if (Array.isArray(value)) {
        value.forEach((child) => {
          visit(child, activeFunction);
        });
      } else visit(value, activeFunction);
    }
  };
  visit(parse(source, { sourceType: "script" }));
  return [...labels].sort((left, right) => left.localeCompare(right, "en"));
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("draw.io bundle integrity", () => {
  test("generates the fixed single-row patent toolbar runtime", async () => {
    const appRoot = join(process.cwd(), "resources", "drawio", "app");
    const [embedHtml, embedBridge, toolbarCss] = await Promise.all([
      readFile(join(appRoot, "embed.html"), "utf8"),
      readFile(join(appRoot, "embed-bridge.js"), "utf8"),
      readFile(join(appRoot, "patent-toolbar.css"), "utf8"),
    ]);

    expect(embedHtml).toContain('<link rel="stylesheet" href="patent-toolbar.css">');
    expect(embedBridge).toContain(
      'const toolbarActions = new Set(["toggle-project-menu", "save", "export-external", "export-to-description-drawing", "replace-description-drawing", "project-create", "project-import", "project-rename", "project-duplicate", "project-delete", "cycle-tab-next", "cycle-tab-previous"]);',
    );
    expect(embedBridge).toContain(
      'const projectFileActions = [["新建流程图", "project-create"], ["导入流程图", "project-import"], ["重命名当前流程图", "project-rename"], ["复制当前流程图", "project-duplicate"], ["删除当前流程图", "project-delete"]];',
    );
    expect(embedBridge).toContain("menu.addSeparator(parent);");
    expect(embedBridge.indexOf("projectFileActions")).toBeLessThan(
      embedBridge.indexOf("originalFileMenu.apply"),
    );
    expect(embedBridge).toContain('menubar.classList.add("patent-toolbar")');
    // SVG namespace identifies inert vector elements; it is not a network resource.
    expect(embedBridge.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(
      /eval\(|new Function|innerHTML|MutationObserver|https?:\/\//u,
    );
    expect(toolbarCss).toContain("flex-wrap:nowrap");
    expect(toolbarCss).toContain(".patent-toolbar__button--primary");
    expect(toolbarCss).toContain(".patent-toolbar__menus>.geMenubar{position:static!important");
    expect(toolbarCss).toContain(".patent-toolbar .geStatus{display:none!important}");
    expect(embedBridge).toContain("PatentCircuitQuickWiring.install");
    expect(embedBridge).toContain('createToolbarButton("快捷连线"');
    expect(embedBridge).toContain("quickWiring.setEditorMode(mode)");
    expect(embedBridge).toContain('window.addEventListener("beforeunload"');
    expect(toolbarCss).toContain(".patent-toolbar__circuit-tools");
    expect(toolbarCss).toContain(".patent-circuit-quick-wiring-port");
  });
  it("parses comments and blank lines and emits overrides in deterministic key order", () => {
    expect(parseDrawioOverrides("# patent terms\n\nzeta=末项\nalpha=首项\n")).toBe(
      "alpha=首项\nzeta=末项\n",
    );
  });

  it.each([
    ["duplicate keys", "key=一\nkey=二", "duplicate"],
    ["empty key", "=值", "empty key"],
    ["empty value", "key=", "empty value"],
    ["malformed line", "key", "malformed"],
    ["control character", "key=值\u0000", "control"],
    ["C1 control character", "key=值\u0085", "control"],
    ["external URI", "key=https://example.invalid", "external URI"],
    ["protocol-relative URI", "key=//example.invalid/a", "external URI"],
    ["mailto URI", "key=mailto:patent@example.invalid", "external URI"],
    ["URN URI", "key=urn:example:patent", "external URI"],
    ["embedded mailto URI", "key=请联系mailto:x@example.com", "external URI"],
    ["embedded URN URI", "key=前缀urn:example:patent", "external URI"],
    ["allowed SVG token used as a scheme", "key=请联系SVG:内容", "external URI"],
    ["allowed PDF token used as a scheme", "key=PDF:内容", "external URI"],
    ["allowed draw.io token used as a scheme", "key=draw.io:内容", "external URI"],
  ])("rejects %s in supplemental resources", (_name, source, message) => {
    expect(() => parseDrawioOverrides(source)).toThrow(message);
  });

  it("accepts Chinese punctuation and draw.io placeholders", () => {
    expect(parseDrawioOverrides("key=步骤：{1}（可选）\n")).toBe("key=步骤：{1}（可选）\n");
  });

  it("defines the exact case-sensitive preserved product and file-format tokens", () => {
    expect(PRESERVED_LOCALIZATION_TOKENS).toEqual(["draw.io", "SVG", "PDF", "PNG", "JPEG", "XML"]);
  });

  it("rejects override keys absent from the official Chinese resource", () => {
    expect(() => validateDrawioOverrides("unknownPatentKey=术语\n", "known=已知\n")).toThrow(
      "unknown override key",
    );
  });

  it("rejects unapproved Latin word tokens while allowing preserved exact-case tokens", () => {
    expect(() => validateDrawioOverrides("known=Patent 术语\n", "known=已知\n")).toThrow(
      "unapproved Latin token",
    );
    expect(
      validateDrawioOverrides("known=draw.io、SVG、PDF、PNG、JPEG、XML 与 {1}\n", "known=已知\n"),
    ).toBe("known=draw.io、SVG、PDF、PNG、JPEG、XML 与 {1}\n");
  });

  it.each(["é", "术语résumé", "café术语"])(
    "rejects Unicode Latin script in override values: %s",
    (value) => {
      expect(() => validateDrawioOverrides(`known=${value}\n`, "known=已知\n")).toThrow(
        "unapproved Latin token",
      );
    },
  );

  it.each(["PDFSVG", "draw.ioPDF", "XMLJPEG"])(
    "rejects concatenated preserved localization tokens: %s",
    (value) => {
      expect(() => validateDrawioOverrides(`known=${value}\n`, "known=已知\n")).toThrow(
        "unapproved Latin token",
      );
    },
  );

  it.each(["𝐏𝐃𝐅", "ⓅⒹⒻ", "ＰＤＦ"])(
    "rejects compatibility Unicode disguised as an allowed Latin token: %s",
    (value) => {
      expect(() => validateDrawioOverrides(`known=${value}\n`, "known=已知\n")).toThrow(
        "unapproved Latin token",
      );
    },
  );

  it("preserves Chinese compatibility characters while validating their NFKC form", () => {
    expect(validateDrawioOverrides("known=車辆\n", "known=已知\n")).toBe("known=車辆\n");
  });

  it.each(["PDF/SVG", "draw.io（SVG）"])(
    "accepts preserved localization tokens separated by a boundary: %s",
    (value) => {
      expect(validateDrawioOverrides(`known=${value}\n`, "known=已知\n")).toBe(`known=${value}\n`);
    },
  );

  it("manifests the generated supplemental resource and preserves text resource MIME compatibility", async () => {
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), "resources", "drawio", "manifest.json"), "utf8"),
    );
    expect(
      manifest.files.some((file: { path: string }) => file.path === "app/resources/patent_zh.txt"),
    ).toBe(true);
    const resource = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "resources", "patent_zh.txt"),
    );
    expect(resource.includes(0)).toBe(false);
    expect(resource.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it("loads the combined official-then-supplemental resource before the editor entry point", async () => {
    const indexHtml = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "index.html"),
      "utf8",
    );
    const localization = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "patent-localization.js"),
      "utf8",
    );
    const combined = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "resources", "patent_zh.txt"),
      "utf8",
    );
    const official = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "resources", "dia_zh.txt"),
      "utf8",
    );
    expect(indexHtml.indexOf('<script src="patent-localization.js"></script>')).toBeLessThan(
      indexHtml.indexOf('<script src="js/main.js"></script>'),
    );
    const officialEnglish = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "resources", "dia.txt"),
      "utf8",
    );
    const toolLabels = parseDrawioToolLabels(
      await readFile(
        join(process.cwd(), "resources", "drawio", "localization", "tool-labels-zh.json"),
        "utf8",
      ),
    );
    expect(localization).toBe(
      buildPatentLocalizationBootstrap(officialEnglish, official, toolLabels),
    );
    expect(localization).toContain(
      'element.closest(".geDiagramContainer,.geItem,.gePageTab")==null',
    );
    expect(localization).toContain(
      'window.addEventListener("load",installPatentEditorPolicy,{once:true})',
    );
    expect(localization).toContain('this.put("patentAdvanced"');
    expect(localization).toContain('this.put("file"');
    expect(localization).toContain('this.put("edit"');
    expect(localization).toContain('this.put("view"');
    expect(localization).toContain('this.put("arrange"');
    expect(localization).toContain('this.put("extras"');
    expect(localization).toContain('this.addMenuItems(menu,["grid","guides"],parent)');
    expect(localization).toContain(
      'const exportOptionLabels=new Set([mxResources.get("grid"),mxResources.get("shadow")])',
    );
    expect(localization).toContain('const libraryPolicyVersion="patent-library-policy-v1"');
    expect(localization).toContain("mxSettings.setLibraries(Sidebar.prototype.defaultEntries)");
    expect(localization).toContain(
      'entry.id==="general"?Object.assign({},entry,{libs:["general"]})',
    );
    expect(localization).toContain('{title:"杂项与高级",id:"patent_extensions"}');
    expect(localization).not.toContain('hiddenMenuItems.add("grid")');
    expect(localization).not.toContain('hiddenMenuItems.add("shadow")');
    expect(localization).not.toContain("Document.prototype.createTextNode");
    expect(localization).not.toContain("Object.defineProperty");
    expect(localization).not.toContain("MutationObserver");
    expect(combined.startsWith(`${official.replaceAll("\r\n", "\n").trimEnd()}\n`)).toBe(true);
    expect(combined).not.toMatch(/(?:https?|wss?|ftp|file|data|javascript):|\/\/[A-Za-z0-9]/iu);
  });
  it("locks the patent-focused menu and library policy without removing edit grid or shadow", () => {
    expect(PATENT_HIDDEN_MENU_ITEMS).toEqual([
      "editTooltip",
      "editLink",
      "openLink",
      "tags",
      "scratchpad",
      "animations",
      "diagramLanguage",
      "editDiagram",
      "plugins",
      "embed",
      "print",
    ]);
    expect(PATENT_HIDDEN_MENU_ITEMS).not.toContain("grid");
    expect(PATENT_HIDDEN_MENU_ITEMS).not.toContain("shadow");
    expect(PATENT_ADVANCED_MENU_ITEMS).toEqual([
      "editData",
      "editStyle",
      "editGeometry",
      "editPolygon",
      "editConnectionPoints",
      "layers",
      "ruler",
      "pageScale",
      "units",
      "layout",
      "collapseExpand",
    ]);
    expect(PATENT_DEFAULT_LIBRARY_ENTRIES).toBe("general;basic;arrows2;flowchart;er;uml");
    expect(PATENT_HIDDEN_LIBRARY_ENTRIES).toEqual(
      expect.arrayContaining(["ios", "mockups", "alibaba_cloud", "aws4", "azure2", "gcp2"]),
    );
    expect(PATENT_HIDDEN_LIBRARY_ENTRIES).not.toContain("misc");
    expect(PATENT_HIDDEN_LIBRARY_ENTRIES).not.toContain("advanced");
  });
  it("keeps flowchart and circuit libraries mutually exclusive", () => {
    expect(PATENT_DEFAULT_LIBRARY_ENTRIES).toBe("general;basic;arrows2;flowchart;er;uml");
    expect(PATENT_CIRCUIT_LIBRARY_ENTRIES).toBe("electrical");
    expect(PATENT_DEFAULT_LIBRARY_ENTRIES.split(";")).not.toContain("electrical");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('action === "patent-set-editor-mode"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('event: "editor-mode"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('createToolbarButton("流程图"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('createToolbarButton("电路图"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('message.type === "set-editor-mode"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('["flowchart", "circuit"].includes(message.mode)');
  });
  it("generates localized sidebar tooltip titles from official draw.io resources", () => {
    const localization = buildPatentLocalizationBootstrap(
      "rectangle=Rectangle\nellipse=Ellipse\nsvg=SVG\n",
      "rectangle=矩形\nellipse=椭圆\nsvg=SVG\n",
    );

    expect(localization).toContain('const tooltipLabels={"Ellipse":"椭圆","Rectangle":"矩形"};');
    expect(localization).toContain('element.parentElement?.classList.contains("geSidebarTooltip")');
    expect(localization).toContain(
      "Object.prototype.hasOwnProperty.call(tooltipLabels,value)?tooltipLabels[value]:value",
    );
    expect(localization).toContain(".geDialog");
    expect(localization).toContain('"iOS Icons":"苹果移动系统图标"');
    expect(localization).toContain('"SimSun":"宋体"');
    expect(localization).not.toContain('"SVG":"SVG"');
  });
  it("validates and deterministically sorts supplemental tool labels", () => {
    expect(parseDrawioToolLabels('{"Zigzag":"锯齿线","Actor":"参与者"}')).toEqual({
      Actor: "参与者",
      Zigzag: "锯齿线",
    });
    expect(() => parseDrawioToolLabels('{"Actor":"Actor"}')).toThrow("remains untranslated");
    expect(() => parseDrawioToolLabels('{"Actor":""}')).toThrow("empty label");
  });
  it("has a Chinese tooltip for every bundled default and patent-library tool", async () => {
    const appRoot = join(process.cwd(), "resources", "drawio", "app");
    const officialEnglish = await readFile(join(appRoot, "resources", "dia.txt"), "utf8");
    const officialChinese = await readFile(join(appRoot, "resources", "dia_zh.txt"), "utf8");
    const labels = new Set(
      collectDefaultPaletteToolLabels(await readFile(join(appRoot, "js", "app.min.js"), "utf8")),
    );
    for (const library of DRAWIO_POLICY.libraries) {
      const stencil = await readFile(join(appRoot, "stencils", `${library}.xml`), "utf8");
      for (const match of stencil.matchAll(/<shape\s+name="([^"]+)"/gu)) labels.add(match[1]);
    }
    const translations = {
      ...buildDrawioTooltipLabels(officialEnglish, officialChinese),
      ...parseDrawioToolLabels(
        await readFile(
          join(process.cwd(), "resources", "drawio", "localization", "tool-labels-zh.json"),
          "utf8",
        ),
      ),
      ...DRAWIO_UI_LABELS,
    };
    const missing = [...labels]
      .filter((label) => /\p{Script=Latin}/u.test(label) && translations[label] == null)
      .sort((left, right) => left.localeCompare(right, "en"));
    expect(missing, `工具悬浮名称缺少中文映射：\n${missing.join("\n")}`).toEqual([]);
  });
  it("sets Simplified Chinese during draw.io's initial URL parameter parse", async () => {
    const bootstrap = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "js", "bootstrap.js"),
      "utf8",
    );

    expect(bootstrap).toContain('result.lang = "zh";');
    expect(bootstrap.indexOf('result.lang = "zh";')).toBeLessThan(
      bootstrap.indexOf("return result;"),
    );
  });
  it("applies the pinned bootstrap locale transform exactly once and fails closed", async () => {
    const { forceSimplifiedChineseBootstrap } = await import("./vendor-drawio.mjs");
    const source = [
      "before",
      "    ",
      "    return result;",
      "})();",
      "",
      "// Forces CDN caches by passing URL parameters via URL hash",
      "after",
    ].join("\r\n");

    expect(forceSimplifiedChineseBootstrap(source)).toBe(
      `// ${DRAWIO_MODIFICATION_NOTICE}\n` +
        [
          "before",
          "    ",
          '    result.lang = "zh";',
          "    return result;",
          "})();",
          "",
          "// Forces CDN caches by passing URL parameters via URL hash",
          "after",
        ].join("\r\n"),
    );
    expect(() => forceSimplifiedChineseBootstrap("return result;")).toThrow(
      "pinned URL parameter sentinel",
    );
    expect(() => forceSimplifiedChineseBootstrap(`${source}\r\n${source}`)).toThrow("exactly once");
  });
  it("loads the locale-patched bootstrap before embed runtime consumers", async () => {
    const embedHtml = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "embed.html"),
      "utf8",
    );

    expect(embedHtml.indexOf('<script src="js/bootstrap.js"></script>')).toBeLessThan(
      embedHtml.indexOf('<script src="js/main.js"></script>'),
    );
  });
  it("vendors the audited circuit wiring runtime before the embed bridge", async () => {
    const root = join(process.cwd(), "resources", "drawio");
    const runtimeFiles = [
      "circuit-domain.js",
      "circuit-component-policy.js",
      "circuit-quick-wiring.js",
    ];
    const html = await readFile(join(root, "app", "embed.html"), "utf8");
    const pairs = await Promise.all(
      runtimeFiles.map(async (file) => [
        await readFile(join(root, "runtime", file), "utf8"),
        await readFile(join(root, "app", file), "utf8"),
      ]),
    );
    for (const [index, [sourceFile, generatedFile]] of pairs.entries()) {
      expect(generatedFile).toBe(sourceFile);
      expect(html.indexOf(`src="${runtimeFiles[index]}"`)).toBeGreaterThan(-1);
      expect(html.indexOf(`src="${runtimeFiles[index]}"`)).toBeLessThan(
        html.indexOf('src="embed-bridge.js"'),
      );
    }
    for (let index = 1; index < runtimeFiles.length; index += 1) {
      expect(html.indexOf(`src="${runtimeFiles[index - 1]}"`)).toBeLessThan(
        html.indexOf(`src="${runtimeFiles[index]}"`),
      );
    }
    for (const removedRuntime of ["circuit-layout-core.js", "circuit-auto-layout.js"]) {
      expect(html).not.toContain(`src="${removedRuntime}"`);
      await expect(readFile(join(root, "app", removedRuntime), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    const [source, generated] = pairs[2];

    expect(generated).toBe(source);
    expect(source).toContain("domain.isCircuitStyle(style)");
    expect(source).toContain('event.target.closest?.(".patent-circuit-quick-wiring-port")');
    expect(generated).not.toMatch(/https?:|wss?:|eval\(|new Function|MutationObserver/u);
  });
  it("keeps grid and shadow editing controls while export policy remains host-controlled", async () => {
    const embedConfig = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "embed-config.js"),
      "utf8",
    );
    const adapter = await readFile(
      join(process.cwd(), "resources", "drawio", "app", "adapter.js"),
      "utf8",
    );
    expect(embedConfig).not.toContain('urlParams.shadow="0"');
    expect(adapter).not.toContain("config: { grid: false, shadow: false");
    expect(adapter).toBe(DRAWIO_ADAPTER_SOURCE);
  });
  it("keeps vendored runtime and license bytes stable across Git checkouts", async () => {
    const attributes = await readFile(join(process.cwd(), ".gitattributes"), "utf8");
    expect(attributes).toContain("resources/drawio/** -text");
    expect(attributes).toContain("resources/licenses/drawio/** -text");
  });
  it("binds the generated adapter to one strict host context and caps raw saves", () => {
    expect(DRAWIO_ADAPTER_SOURCE).toContain("const validCommand");
    expect(DRAWIO_ADAPTER_SOURCE).toContain("CONTEXT_MISMATCH");
    expect(DRAWIO_ADAPTER_SOURCE).toContain("SOURCE_TOO_LARGE");
    expect(DRAWIO_ADAPTER_SOURCE).toContain("bytes(message.xml) > maxSourceBytes");
    expect(DRAWIO_ADAPTER_SOURCE).toContain('send("ready", { pages');
  });
  it("serializes source saves through supported XML exports after the document loads", () => {
    expect(DRAWIO_ADAPTER_SOURCE).toContain('kind: "save", requestId: message.requestId');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('format: "xml"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('message.event === "load"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain("documentLoaded = true");
    expect(DRAWIO_ADAPTER_SOURCE).toContain("activeExport");
    expect(DRAWIO_ADAPTER_SOURCE).not.toContain('raw({ action: "save"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('? "source-export" : "export"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('request.kind === "source-export"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain("format: request.format, data: message.xml");
  });
  it("retries toolbar actions until the host acknowledges the same action id", () => {
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("pendingToolbarActions");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('message.action === "patent-toolbar-action-ack"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('type === "toolbar-action-ack"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('action: "patent-toolbar-action-ack"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain(
      'send("toolbar-action", { action: message.action, actionId: message.actionId })',
    );
  });
  it("offers only supported computer exports and requests safe SVG before local conversion", () => {
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain(
      'const external = createToolbarButton("导出至电脑", "patent-toolbar__export-computer"',
    );
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain(
      'const drawing = createToolbarButton("插入附图", "patent-toolbar__button--primary"',
    );
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain(
      "actions.append(status, undo, redo, save, external, replacement, drawing)",
    );
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).not.toContain(
      'createToolbarButton("导出", "patent-toolbar__button--primary"',
    );
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).not.toContain("patent-toolbar__export-menu");
    expect(DRAWIO_ADAPTER_SOURCE).toContain(
      'const exportFormats = ["drawio", "svg", "png", "jpeg", "pdf"]',
    );
    expect(DRAWIO_ADAPTER_SOURCE).toContain(
      'activeExport.format !== "drawio") raw({ action: "patent-export-svg"',
    );
    expect(DRAWIO_ADAPTER_SOURCE).not.toContain('"webp"');
  });
  it("routes selection-only exports through the real editor selection instead of an ignored flag", () => {
    expect(DRAWIO_ADAPTER_SOURCE).toContain('action: "patent-export-selection"');
    expect(DRAWIO_ADAPTER_SOURCE).not.toContain(
      "selectionOnly: activeExport.selectionOnly ? 1 : 0",
    );
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('message.action === "patent-export-selection"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("graph.getSelectionCells()");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("graph.getSvg(");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("isObjectIgnored");
  });

  it("exports visible text as safe SVG text without HTML foreign objects", () => {
    expect(DRAWIO_ADAPTER_SOURCE).toContain(
      'if (activeExport.kind === "save") raw({ action: "export", format: "xml" })',
    );
    expect(DRAWIO_ADAPTER_SOURCE).toContain('action: "patent-export-svg"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('message.action === "patent-export-svg"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('getElementsByTagName("foreignObject")');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('getElementsByTagName("switch")');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("Graph.foreignObjectWarningLink");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("canvas.allowConvertHtmlToSvg = true");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("graph.createSvgCanvas = originalCreateSvgCanvas");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain(
      "graph.getSvg(background, 1, 0, false, true, !selectionOnly, true",
    );
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).not.toContain("editorUi.embedFonts(svgRoot");
  });
  it("forwards real editor selection changes through the strict adapter", () => {
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("EditorUi.prototype.init");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('window.addEventListener("load", installBridge');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("graph.getSelectionModel().addListener");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('event: "selection"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('message.event === "selection"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain('send("selection-changed"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain("selectedCellIds: message.selectedCellIds");
  });
  it("forwards real multipage state and active page changes", () => {
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('this.editor.addListener("pageSelected"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('this.editor.addListener("fileLoaded"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('event: "pages"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('message.action !== "patent-set-page"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("editorUi.selectPage(page)");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("message.pageId.match(/^page-(\\d+)$/)");
    expect(DRAWIO_ADAPTER_SOURCE).toContain('message.event === "pages"');
    expect(DRAWIO_ADAPTER_SOURCE).toContain(
      'raw({ action: "patent-set-page", pageId: message.pageId })',
    );
    expect(DRAWIO_ADAPTER_SOURCE).toContain('send("ready", { pages, activePageId');
    expect(DRAWIO_ADAPTER_SOURCE).toContain(
      'send("page-changed", { pageId: message.activePageId })',
    );
  });
  it("forwards host undo and redo to the real editor action registry", () => {
    expect(DRAWIO_ADAPTER_SOURCE).toContain('["undo", "redo"].includes(message.type)');
    expect(DRAWIO_ADAPTER_SOURCE).toContain(
      'raw({ action: "patent-command", command: message.type })',
    );
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain('message.action === "patent-command"');
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain("editorUi.actions.get(message.command)");
  });
  it("removes external draw.io metadata from the offline editor page", () => {
    expect(
      sanitizeDrawioIndexHtml(
        '<meta itemprop="image" content="https://example.invalid/image.png">\n<link rel="canonical" href="https://app.diagrams.net">\n<script src="js/bootstrap.js"></script>',
      ),
    ).toBe(`<!-- ${DRAWIO_MODIFICATION_NOTICE} -->\n<script src="js/bootstrap.js"></script>`);
  });

  it("keeps every remaining static editor entry dependency in the approved runtime", async () => {
    const root = await createValidBundle();
    const bundle = join(root, "resources", "drawio");
    await writeFile(
      join(bundle, "app", "index.html"),
      '<link rel="stylesheet" href="styles/grapheditor.css"><script src="js/bootstrap.js"></script>',
      "utf8",
    );
    await writeFile(
      join(bundle, "manifest.json"),
      `${JSON.stringify(await createManifest(bundle))}\n`,
      "utf8",
    );

    await expect(auditDrawioBundle(root)).resolves.toBe("draw.io v30.0.4 bundle audit passed");
  });

  it("accepts only verified first-party UI resources alongside the upstream bundle", async () => {
    const root = await createValidBundle();
    const bundle = join(root, "resources", "drawio");
    await writeFile(
      join(bundle, "app", "embed.html"),
      '<link href="workbench-ui.css"><script src="workbench-ui.js"></script><script src="surface-adaptation.js"></script>',
    );
    await writeFile(
      join(bundle, "manifest.json"),
      `${JSON.stringify(await createManifest(bundle))}\n`,
    );
    await mkdir(join(root, "resources/ui"), { recursive: true });
    await writeFile(join(root, "resources/ui/workbench-ui.css"), "/* first-party styles */");
    await writeFile(join(root, "resources/ui/workbench-ui.js"), "/* first-party runtime */");
    const hook = await readFile(join(process.cwd(), "resources/drawio/app/surface-adaptation.js"));
    await writeFile(join(bundle, "app/surface-adaptation.js"), hook);
    await expect(auditDrawioBundle(root)).resolves.toContain("audit passed");
    await writeFile(join(bundle, "app/surface-adaptation.js"), "unexpected code");
    await expect(auditDrawioBundle(root)).rejects.toThrow("surface adaptation hook hash mismatch");
  });

  it("rejects an editor entry page that references a local file outside the approved bundle", async () => {
    const root = await createValidBundle();
    const bundle = join(root, "resources", "drawio");
    await writeFile(
      join(bundle, "app", "index.html"),
      '<script src="js/missing-runtime.js"></script>',
      "utf8",
    );
    await writeFile(
      join(bundle, "manifest.json"),
      `${JSON.stringify(await createManifest(bundle))}\n`,
      "utf8",
    );

    await expect(auditDrawioBundle(root)).rejects.toThrow("local runtime dependency");
  });

  it("checks the adapter page's local editor dependency as well", async () => {
    const root = await createValidBundle();
    const bundle = join(root, "resources", "drawio");
    await writeFile(
      join(bundle, "app", "adapter.html"),
      '<iframe src="embed-missing.html"></iframe>',
      "utf8",
    );
    await writeFile(
      join(bundle, "manifest.json"),
      `${JSON.stringify(await createManifest(bundle))}\n`,
      "utf8",
    );

    await expect(auditDrawioBundle(root)).rejects.toThrow("local runtime dependency");
  });

  it("accepts only the adapter's two fixed local protocol origins", async () => {
    const root = await createValidBundle();
    const bundle = join(root, "resources", "drawio");
    await writeFile(
      join(bundle, "app", "adapter.js"),
      'const parent = "patent-app://app"; const editor = "patent-diagram://editor";',
      "utf8",
    );
    await writeFile(
      join(bundle, "manifest.json"),
      `${JSON.stringify(await createManifest(bundle))}\n`,
      "utf8",
    );

    await expect(auditDrawioBundle(root)).resolves.toBe("draw.io v30.0.4 bundle audit passed");
  });

  it("removes non-W3C external endpoints from the offline runtime", () => {
    expect(
      sanitizeDrawioRuntime(
        'const cloud = "https://app.diagrams.net"; const socket = "wss://example.invalid"; const extension = "chrome-extension://abc"; const svg = "http://www.w3.org/2000/svg";',
      ),
    ).toBe(
      `# ${DRAWIO_MODIFICATION_NOTICE}\nconst cloud = ""; const socket = ""; const extension = ""; const svg = "http://www.w3.org/2000/svg";`,
    );
  });

  it("does not add license notices to the published runtime manifest", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "templates"), { recursive: true });
    await writeFile(join(root, "app", "index.html"), "editor", "utf8");
    await writeFile(join(root, "templates", "patent-basic-flowchart.drawio"), "<mxfile/>", "utf8");
    await writeFile(join(root, "NOTICE"), "notice", "utf8");
    await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), "notices", "utf8");

    await expect(createManifest(root)).resolves.toMatchObject({
      files: [{ path: "app/index.html" }, { path: "templates/patent-basic-flowchart.drawio" }],
    });
  });

  it("keeps the invoking repository's Git proxy for a clone launched from a temporary folder", () => {
    expect(
      projectGitProxyArgs(
        [
          "http.proxy http://127.0.0.1:7890",
          "https.proxy http://127.0.0.1:7890",
          "http.proxy http://127.0.0.1:7897",
          "https.proxy http://127.0.0.1:7897",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      "-c",
      "http.proxy=http://127.0.0.1:7897",
      "-c",
      "https.proxy=http://127.0.0.1:7897",
    ]);
  });

  it("stores the unmodified pinned Apache license with its fixed hash", async () => {
    const license = await readFile(
      join(process.cwd(), "resources", "licenses", "drawio", "LICENSE"),
    );
    const text = license.toString("utf8");
    expect(text.trimStart().startsWith("Apache License")).toBe(true);
    expect(text).not.toContain("Exit code:");
    expect(text).not.toContain("Wall time:");
    expect(text).not.toContain("Output:");
    expect(createHash("sha256").update(license).digest("hex")).toBe(DRAWIO_LICENSE_HASH);
  });

  it("rejects a checkout whose HEAD or tag differs from the pinned upstream", async () => {
    await expect(
      verifyPinnedUpstream(
        "fixture",
        async () => DRAWIO_POLICY.upstream.commit,
        async () => "wrong-tag",
      ),
    ).rejects.toThrow("does not match v30.0.4");
    await expect(
      verifyPinnedUpstream(
        "fixture",
        async () => "wrong-head",
        async () => DRAWIO_POLICY.upstream.tag,
      ),
    ).rejects.toThrow("does not match 88ee1f5ab4d40603a8f3aaa0d9d6dc3794c6b3f0");
  });

  it("rejects a dirty DRAWIO_SOURCE_PATH checkout", async () => {
    await expect(
      verifyPinnedUpstream(
        "fixture",
        async () => DRAWIO_POLICY.upstream.commit,
        async () => DRAWIO_POLICY.upstream.tag,
        async () => " M src/main/webapp/index.html",
      ),
    ).rejects.toThrow("uncommitted changes");
  });

  it("keeps the previous complete bundle when publication fails", async () => {
    const root = await makeRoot();
    const oldApp = join(root, "resources", "drawio", "app", "index.html");
    const stageApp = join(root, "stage", "app", "index.html");
    await mkdir(join(root, "resources", "drawio", "app"), { recursive: true });
    await mkdir(join(root, "stage", "app"), { recursive: true });
    await writeFile(oldApp, "old bundle", "utf8");
    await writeFile(stageApp, "new bundle", "utf8");
    await expect(
      publishDrawioBundle({
        rootDirectory: root,
        stageRoot: join(root, "stage"),
        copyDirectory: async () => {
          throw new Error("simulated publish failure");
        },
      }),
    ).rejects.toThrow("simulated publish failure");
    await expect(readFile(oldApp, "utf8")).resolves.toBe("old bundle");
  });

  it("restores the previous bundle after a later release move fails", async () => {
    const root = await makeRoot();
    const oldApp = join(root, "resources", "drawio", "app", "index.html");
    const stage = join(root, "stage");
    await mkdir(join(root, "resources", "drawio", "app"), { recursive: true });
    await mkdir(join(root, "resources", "licenses", "drawio"), { recursive: true });
    await mkdir(join(stage, "app"), { recursive: true });
    await mkdir(join(stage, "runtime"), { recursive: true });
    await mkdir(join(stage, "templates"), { recursive: true });
    await writeFile(join(root, "resources", "drawio", "upstream.json"), "{}", "utf8");
    await writeFile(oldApp, "old bundle", "utf8");
    await writeFile(join(stage, "app", "index.html"), "new bundle", "utf8");
    await writeFile(join(stage, "runtime", "circuit-quick-wiring.js"), "runtime", "utf8");
    await writeFile(join(stage, "manifest.json"), "{}", "utf8");
    for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
      await writeFile(join(stage, name), name, "utf8");
      await writeFile(join(root, "resources", "licenses", "drawio", name), `old ${name}`, "utf8");
    }
    let moveCount = 0;
    await expect(
      publishDrawioBundle({
        rootDirectory: root,
        stageRoot: stage,
        move: async (from, to) => {
          moveCount += 1;
          if (moveCount === 3) throw new Error("simulated late move failure");
          await rename(from, to);
        },
      }),
    ).rejects.toThrow("simulated late move failure");
    await expect(readFile(oldApp, "utf8")).resolves.toBe("old bundle");
  });

  it("keeps the new bundle when post-publication backup cleanup fails", async () => {
    const root = await makeRoot();
    const stage = await createPublishFixture(root);
    await expect(
      publishDrawioBundle({
        rootDirectory: root,
        stageRoot: stage,
        remove: async (path, options) => {
          if (path.includes("licenses") && path.includes(".drawio-backup-")) {
            throw new Error("simulated backup cleanup failure");
          }
          await rm(path, options);
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(root, "resources", "drawio", "app", "index.html"), "utf8"),
    ).resolves.toBe("new bundle");
  });

  it.each(["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"])(
    "rejects tampered license material: %s",
    async (name) => {
      const root = await createValidBundle();
      await expect(auditDrawioBundle(root)).resolves.toBe("draw.io v30.0.4 bundle audit passed");
      await writeFile(join(root, "resources", "licenses", "drawio", name), "rewritten", "utf8");
      await expect(auditDrawioBundle(root)).rejects.toThrow(name);
    },
  );

  it.each([
    ["https://example.invalid/script.js"],
    ["https://app.diagrams.net"],
    ["ws://example.invalid/socket"],
    ["wss://example.invalid/socket"],
    ["ftp://example.invalid/runtime.js"],
    ["ftps://example.invalid/runtime.js"],
    ["file:///C:/outside/runtime.js"],
    ["//example.invalid/runtime.css"],
  ])(
    "allows inert external endpoint constants in unmodified upstream JavaScript: %s",
    async (url) => {
      const root = await createValidBundle({ appText: `const remote = '${url}';` });
      await expect(auditDrawioBundle(root)).resolves.toBe("draw.io v30.0.4 bundle audit passed");
    },
  );

  it.each([
    ["adapter.js"],
    ["embed-config.js"],
    ["embed-bridge.js"],
    ["index.html"],
    ["embed.html"],
    ["resources/dia.txt"],
    ["resources/patent_zh.txt"],
  ])("rejects an external runtime URL in audited generated or text file: %s", async (path) => {
    const root = await createValidBundle();
    await replaceAppFile(root, path, "const remote = 'https://example.invalid/script.js';");
    await expect(auditDrawioBundle(root)).rejects.toThrow("external URL");
  });

  it("allows the required W3C SVG namespace constants", async () => {
    const root = await createValidBundle({
      appText:
        'const math = "http://www.w3.org/1998/Math/MathML"; const svg = "http://www.w3.org/2000/svg"; const xhtml = "http://www.w3.org/1999/xhtml"; const xlink = "http://www.w3.org/1999/xlink"; const xml = "http://www.w3.org/XML/1998/namespace"; const dtd = "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd";',
    });
    await expect(auditDrawioBundle(root)).resolves.toBe("draw.io v30.0.4 bundle audit passed");
  });

  it("does not mistake CSS declarations for external URLs", async () => {
    const root = await createValidBundle({
      appText: "@media (forced-colors: active) { z-index: -3; }",
    });
    await expect(auditDrawioBundle(root)).resolves.toBe("draw.io v30.0.4 bundle audit passed");
  });

  it.each([
    ["app/../templates/patent-basic-flowchart.drawio"],
    ["app\\js\\app.min.js"],
    ["C:/absolute/app.min.js"],
  ])("rejects a non-canonical manifest path: %s", async (path) => {
    const root = await createValidBundle();
    await replaceManifest(root, (manifest) => ({
      ...manifest,
      files: [{ ...manifest.files[0], path }],
    }));
    await expect(auditDrawioBundle(root)).rejects.toThrow("manifest path");
  });

  it("rejects manifest paths that are duplicated, unsorted, or have the wrong hash", async () => {
    const root = await createValidBundle();
    await replaceManifest(root, (manifest) => ({
      ...manifest,
      files: [...manifest.files, manifest.files[0]],
    }));
    await expect(auditDrawioBundle(root)).rejects.toThrow("duplicate");

    const orderedRoot = await createValidBundle();
    await replaceManifest(orderedRoot, (manifest) => ({
      ...manifest,
      files: [...manifest.files].reverse(),
    }));
    await expect(auditDrawioBundle(orderedRoot)).rejects.toThrow("not sorted");

    const hashRoot = await createValidBundle();
    await replaceManifest(hashRoot, (manifest) => ({
      ...manifest,
      files: [{ ...manifest.files[0], sha256: "0".repeat(64) }, ...manifest.files.slice(1)],
    }));
    await expect(auditDrawioBundle(hashRoot)).rejects.toThrow("hash mismatch");
  });

  it("rejects source or generated supplemental localization drift", async () => {
    const sourceRoot = await createLocalizationAuditFixture();
    await writeFile(
      join(sourceRoot, "resources", "drawio", "localization", "zh-cn-overrides.txt"),
      "diagram=专利流程图\n",
      "utf8",
    );
    await expect(auditDrawioBundle(sourceRoot)).rejects.toThrow("localization consistency");

    const generatedRoot = await createLocalizationAuditFixture();
    await replaceAppFile(
      generatedRoot,
      "resources/patent_zh.txt",
      "diagram=绘图\ndiagram=篡改流程图\n",
    );
    await expect(auditDrawioBundle(generatedRoot)).rejects.toThrow("localization consistency");
  });

  it("rejects source or generated tool-label localization drift", async () => {
    const sourceRoot = await createLocalizationAuditFixture();
    await writeFile(
      join(sourceRoot, "resources", "drawio", "localization", "tool-labels-zh.json"),
      '{"Rectangle":"矩形"}\n',
      "utf8",
    );
    await expect(auditDrawioBundle(sourceRoot)).rejects.toThrow("tool localization consistency");

    const generatedRoot = await createLocalizationAuditFixture();
    await replaceAppFile(generatedRoot, "patent-localization.js", "tampered localization");
    await expect(auditDrawioBundle(generatedRoot)).rejects.toThrow("tool localization consistency");
  });

  it.each([
    ["source", "runtime/circuit-quick-wiring.js"],
    ["generated", "app/circuit-quick-wiring.js"],
  ])("rejects tampered circuit wiring %s and recommends vendoring", async (_name, path) => {
    const root = await createValidBundle();
    await writeFile(join(root, "resources", "drawio", path), "tampered circuit runtime", "utf8");

    await expect(auditDrawioBundle(root)).rejects.toThrow("npm run vendor:drawio");
  });

  it("rejects a template outside the three fixed patent templates", async () => {
    const root = await createValidBundle({ extraTemplate: "evil.drawio" });
    await expect(auditDrawioBundle(root)).rejects.toThrow("template");
  });

  it("rejects symbolic links inside the production bundle", async () => {
    const root = await createValidBundle();
    await expect(
      auditDrawioBundle(root, {
        listFiles: async () => {
          throw new Error("draw.io bundle contains a symbolic link: app/js/app.min.js");
        },
      }),
    ).rejects.toThrow("symbolic link");
  });

  it("rejects unknown files beside the audited circuit runtime source", async () => {
    const root = await createValidBundle();
    const manifest = JSON.parse(
      await readFile(join(root, "resources", "drawio", "manifest.json"), "utf8"),
    );

    await expect(
      auditDrawioBundle(root, {
        listFiles: async () => [
          ...manifest.files.map((entry: { path: string }) => entry.path),
          "manifest.json",
          "upstream.json",
          "localization/tool-labels-zh.json",
          "localization/zh-cn-overrides.txt",
          "runtime/circuit-quick-wiring.js",
          "runtime/unknown-payload.js",
        ],
      }),
    ).rejects.toThrow("production bundle");
  });

  it("tells the license audit how to create a missing draw.io manifest", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "resources", "drawio"), { recursive: true });
    await writeFile(
      join(root, "resources", "drawio", "upstream.json"),
      JSON.stringify({
        ...DRAWIO_POLICY.upstream,
        languages: DRAWIO_POLICY.languages,
        libraries: DRAWIO_POLICY.libraries,
        templates: DRAWIO_POLICY.templates,
      }),
      "utf8",
    );
    await expect(auditLicenses(root)).rejects.toThrow("npm run vendor:drawio");
  });
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "drawio-bundle-test-"));
  temporaryRoots.push(root);
  return root;
}

async function createPublishFixture(root: string) {
  const stage = join(root, "stage");
  await mkdir(join(root, "resources", "drawio", "app"), { recursive: true });
  await mkdir(join(root, "resources", "licenses", "drawio"), { recursive: true });
  await mkdir(join(stage, "app"), { recursive: true });
  await mkdir(join(stage, "runtime"), { recursive: true });
  await mkdir(join(stage, "templates"), { recursive: true });
  await writeFile(join(root, "resources", "drawio", "upstream.json"), "{}", "utf8");
  await writeFile(join(root, "resources", "drawio", "app", "index.html"), "old bundle", "utf8");
  await writeFile(join(stage, "app", "index.html"), "new bundle", "utf8");
  await writeFile(join(stage, "runtime", "circuit-quick-wiring.js"), "runtime", "utf8");
  await writeFile(join(stage, "manifest.json"), "{}", "utf8");
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    await writeFile(join(stage, name), name, "utf8");
    await writeFile(join(root, "resources", "licenses", "drawio", name), `old ${name}`, "utf8");
  }
  return stage;
}

async function createValidBundle({
  appText = "const local = true;",
  extraTemplate,
}: {
  appText?: string;
  extraTemplate?: string;
} = {}) {
  const root = await makeRoot();
  const bundle = join(root, "resources", "drawio");
  await mkdir(join(bundle, "app", "js"), { recursive: true });
  await mkdir(join(bundle, "runtime"), { recursive: true });
  await mkdir(join(bundle, "templates"), { recursive: true });
  await mkdir(join(root, "resources", "licenses", "drawio"), { recursive: true });
  for (const path of allowedAppPaths()) {
    const target = join(bundle, "app", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, path === "js/app.min.js" ? appText : "local resource", "utf8");
  }
  for (const file of CIRCUIT_RUNTIME_FILES) {
    await writeFile(join(bundle, "runtime", file), "local resource", "utf8");
  }
  await mkdir(join(bundle, "localization"), { recursive: true });
  await writeFile(join(bundle, "localization", "zh-cn-overrides.txt"), "diagram=流程图\n", "utf8");
  await writeFile(join(bundle, "localization", "tool-labels-zh.json"), "{}\n", "utf8");
  await writeFile(join(bundle, "app", "resources", "dia.txt"), "diagram=Diagram\n", "utf8");
  await writeFile(join(bundle, "app", "resources", "dia_zh.txt"), "diagram=绘图\n", "utf8");
  await writeFile(
    join(bundle, "app", "patent-localization.js"),
    buildPatentLocalizationBootstrap("diagram=Diagram\n", "diagram=绘图\n", {}),
    "utf8",
  );
  await writeFile(
    join(bundle, "app", "resources", "patent_zh.txt"),
    "diagram=绘图\ndiagram=流程图\n",
    "utf8",
  );
  for (const name of DRAWIO_POLICY.templates) {
    await writeFile(join(bundle, "templates", `${name}.drawio`), "<mxfile/>", "utf8");
  }
  if (extraTemplate) await writeFile(join(bundle, "templates", extraTemplate), "<mxfile/>", "utf8");
  await writeFile(
    join(bundle, "upstream.json"),
    `${JSON.stringify({ ...DRAWIO_POLICY.upstream, languages: DRAWIO_POLICY.languages, libraries: DRAWIO_POLICY.libraries, templates: DRAWIO_POLICY.templates })}\n`,
    "utf8",
  );
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    await cp(
      join(process.cwd(), "resources", "licenses", "drawio", name),
      join(root, "resources", "licenses", "drawio", name),
    );
  }
  const paths = [
    ...allowedAppPaths().map((path) => `app/${path}`),
    ...DRAWIO_POLICY.templates.map((name) => `templates/${name}.drawio`),
    ...(extraTemplate ? [`templates/${extraTemplate}`] : []),
  ].sort((left, right) => left.localeCompare(right, "en"));
  const files = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(join(bundle, path));
      return {
        path,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  await writeFile(
    join(bundle, "manifest.json"),
    `${JSON.stringify({ upstream: DRAWIO_POLICY.upstream, files })}\n`,
    "utf8",
  );
  return root;
}

async function replaceManifest(
  root: string,
  transform: (manifest: {
    upstream: object;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  }) => object,
) {
  const path = join(root, "resources", "drawio", "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify(transform(manifest)), "utf8");
}

async function replaceAppFile(root: string, path: string, contents: string) {
  const bundle = join(root, "resources", "drawio");
  await writeFile(join(bundle, "app", path), contents, "utf8");
  await writeFile(
    join(bundle, "manifest.json"),
    `${JSON.stringify(await createManifest(bundle))}\n`,
    "utf8",
  );
}

async function createLocalizationAuditFixture() {
  const root = await createValidBundle();
  const bundle = join(root, "resources", "drawio");
  await mkdir(join(bundle, "localization"), { recursive: true });
  await writeFile(join(bundle, "localization", "zh-cn-overrides.txt"), "diagram=流程图\n", "utf8");
  await replaceAppFile(root, "resources/dia_zh.txt", "diagram=绘图\n");
  await replaceAppFile(root, "resources/patent_zh.txt", "diagram=绘图\ndiagram=流程图\n");
  return root;
}

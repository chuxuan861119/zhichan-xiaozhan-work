import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  createMacDocumentFontCss,
  withPlatformPrintFonts,
} from "../../src/shared/document/platform-fonts.js";

// Font payloads are tens of MB; screenshots/PDF are the useful evidence, not
// recording those bytes repeatedly in Playwright's DOM trace.
test.use({ trace: "off" });

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a fixture destructuring pattern; Electron supplies the page.
test("Mac editor and PDF use system fonts by default and bundled fonts when selected", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "Mac font rendering regression");
  const userData = await mkdtemp(join(tmpdir(), "patent-mac-fonts-"));
  const app = await electron.launch({
    args: [
      resolve("tests/e2e/fixtures/editor-typography-electron.cjs"),
      `--user-data-dir=${userData}`,
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
      ),
    ),
  });
  try {
    const page = await app.firstWindow();
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
      body { margin: 40px; font-family: SimSun, serif; font-size: 14pt; color: #111827; }
      h1 { font-size:14pt; } p { line-height:1.5; } .title { text-align:center; color:red; }
    </style></head><body><p class="title"><strong>一种换热装置</strong></p>
      <h1><strong id="heading">技术领域</strong></h1>
      <p id="normal">本发明涉及换热技术领域。ABC 123，αβ。</p>
      <p><strong id="bold">背景技术</strong></p>
      <p id="legacy" style="font-family:宋体">旧文档字体名称</p>
      <p id="bundled" style="font-family:Source Han Serif CN">自带思源宋体</p>
      <p><strong id="bundled-bold" style="font-family:Source Han Serif CN">思源粗体</strong></p>
      <p id="system" style="font-family:PingFang SC">系统字体正文</p>
    </body></html>`;
    await page.setContent(html);
    await page.screenshot({ path: testInfo.outputPath("before.png") });
    const dataFont = async (weight: string) =>
      `data:font/otf;base64,${(
        await readFile(resolve(`src/shared/document/fonts/SourceHanSerifCN-${weight}.otf`))
      ).toString("base64")}`;
    const css = createMacDocumentFontCss({
      regular: await dataFont("Regular"),
      semibold: await dataFont("SemiBold"),
    });
    const printHtmlPath = join(userData, "font-preview.html");
    await writeFile(printHtmlPath, withPlatformPrintFonts(html, "darwin", css));
    await page.goto(pathToFileURL(printHtmlPath).href);
    await page.evaluate(() => document.fonts.ready);
    const client = await page.context().newCDPSession(page);
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument");
    for (const [selector, expected] of [
      ["#normal", "PingFangSC-Regular"],
      ["#bold", "PingFangSC-Semibold"],
      ["#heading", "PingFangSC-Semibold"],
      ["#legacy", "PingFangSC-Regular"],
      ["#bundled", "SourceHanSerifCN-Regular"],
      ["#bundled-bold", "SourceHanSerifCN-SemiBold"],
      ["#system", "PingFangSC-Regular"],
    ] as const) {
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      expect(fonts.map((font) => font.postScriptName)).toEqual([expected]);
    }
    await page.screenshot({ path: testInfo.outputPath("after.png") });
    const pdf = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Font verification window is missing");
      return (await window.webContents.printToPDF({ printBackground: true })).toString("base64");
    });
    await writeFile(testInfo.outputPath("mac-fonts.pdf"), Buffer.from(pdf, "base64"));
    expect(pdf.length).toBeGreaterThan(1000);
    const pdfObjects = Buffer.from(pdf, "base64").toString("latin1");
    expect(pdfObjects.includes("+SourceHanSerifCN-Regular")).toBe(true);
    expect(pdfObjects.includes("+SourceHanSerifCN-SemiBold")).toBe(true);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

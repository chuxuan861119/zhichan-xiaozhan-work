import {
  BUNDLED_DOCUMENT_FONT,
  defaultDocumentFont,
  defaultDocumentFontSizePt,
  displayDocumentFont,
  documentFontOptions,
  docxDocumentFont,
} from "./font-policy.js";

test.each([
  ["win32", "SimSun", ["SimSun", "FangSong", "KaiTi", BUNDLED_DOCUMENT_FONT]],
  ["darwin", "PingFang SC", ["PingFang SC", BUNDLED_DOCUMENT_FONT]],
  ["MacIntel", "PingFang SC", ["PingFang SC", BUNDLED_DOCUMENT_FONT]],
  ["openharmony", "HarmonyOS Sans SC", ["HarmonyOS Sans SC", BUNDLED_DOCUMENT_FONT]],
  ["ohos", "HarmonyOS Sans SC", ["HarmonyOS Sans SC", BUNDLED_DOCUMENT_FONT]],
])("%s has its own default and font choices", (platform, expected, choices) => {
  expect(defaultDocumentFont(platform)).toBe(expected);
  expect(documentFontOptions(platform).map((font) => font.value)).toEqual(choices);
});

test("preload platform wins over the Harmony renderer's Linux navigator", () => {
  const runtime = globalThis as typeof globalThis & { documentFontPlatform?: string };
  runtime.documentFontPlatform = "openharmony";
  try {
    expect(defaultDocumentFont()).toBe("HarmonyOS Sans SC");
  } finally {
    delete runtime.documentFontPlatform;
  }
});

test("DOCX preserves Windows fonts, maps bundled/system names, and flags unknown imports", () => {
  for (const font of [BUNDLED_DOCUMENT_FONT, "HarmonyOS Sans SC", "PingFang SC", "宋体"])
    expect(docxDocumentFont(font)).toBe("SimSun");
  expect(docxDocumentFont("仿宋")).toBe("FangSong");
  expect(docxDocumentFont("楷体")).toBe("KaiTi");
  expect(docxDocumentFont("SimHei", "win32")).toBe("SimSun");
  expect(displayDocumentFont("Microsoft YaHei", "win32")).toBe("SimSun");
  expect(docxDocumentFont("Missing font")).toBeNull();
});

test.each(["darwin", "openharmony", "ohos"])(
  "%s exports known fonts as Songti and displays Songti as its own system default",
  (platform) => {
    for (const font of [
      "SimSun",
      "宋体",
      "FangSong",
      "KaiTi",
      "HarmonyOS Sans SC",
      "PingFang SC",
    ]) {
      expect(displayDocumentFont(font, platform)).toBe(defaultDocumentFont(platform));
      expect(docxDocumentFont(font, platform)).toBe("SimSun");
    }
    expect(displayDocumentFont(BUNDLED_DOCUMENT_FONT, platform)).toBe(BUNDLED_DOCUMENT_FONT);
  },
);

test.each([
  ["win32", 14],
  ["darwin", 14],
  ["MacIntel", 14],
  ["openharmony", 14],
  ["ohos", 14],
])("%s uses the platform body size", (platform, expected) => {
  expect(defaultDocumentFontSizePt(platform)).toBe(expected);
});
test("font labels put the font name first without a bundled suffix", () => {
  expect(documentFontOptions("darwin").map(({ label }) => label)).toEqual([
    "苹方（系统自带）",
    "思源宋体",
  ]);
  expect(documentFontOptions("openharmony").map(({ label }) => label)).toEqual([
    "HarmonyOS Sans SC（系统自带）",
    "思源宋体",
  ]);
});

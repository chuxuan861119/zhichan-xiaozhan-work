import { readFileSync } from "node:fs";
import { initializeWindowControls, windowDecorationOptions } from "./window-decoration.js";

test.each(["openharmony", "ohos", "win32", "darwin"])(
  "%s initializes caption permissions only on Harmony",
  (platform) => {
    const target = { setWindowButtonVisibility: vi.fn() };
    initializeWindowControls(target, platform);
    expect(target.setWindowButtonVisibility.mock.calls).toEqual(
      platform === "openharmony" || platform === "ohos" ? [[true]] : [],
    );
  },
);

test.each(["openharmony", "ohos", "win32", "darwin"])(
  "%s keeps window controls in the document tab row",
  (platform) => {
    expect(windowDecorationOptions(platform)).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: platform === "win32" ? "#e7ebf1" : "#f4f5f7",
        symbolColor: "#202124",
        height: 38,
      },
    });
  },
);

test("Windows caption background matches the document tab bar", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  const tabBackground = css.match(/\.patent-tabs\s*\{[^}]*background:\s*(#[\da-f]+);/iu)?.[1];
  expect(tabBackground).toBeDefined();
  expect(windowDecorationOptions("win32").titleBarOverlay).toMatchObject({ color: tabBackground });
});

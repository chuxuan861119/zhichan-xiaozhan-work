import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "vite";

declare global {
  interface Window {
    MotionPolicy: { installMotionPreference(): () => void; prefersReducedMotion(): boolean };
  }
}
let policy = "";
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: {
        entry: path.resolve("src/renderer/src/shared/motion-preference.ts"),
        name: "MotionPolicy",
        formats: ["iife"],
      },
      minify: false,
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  policy = outputs
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((chunk) => chunk.type === "chunk")
    .map((chunk) => chunk.code)
    .join("\n");
});
const appCss =
  fs.readFileSync("src/renderer/src/app/app.css", "utf8") +
  fs.readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8") +
  fs.readFileSync("resources/ui/workbench-ui.css", "utf8");
test("restoring motion keeps open settings visible and animates subsequent openings", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setContent(
    `<style>${appCss}</style><div class="application-settings-dialog"><section class="application-settings-dialog__surface">页面偏好</section></div>`,
  );
  await page.addScriptTag({ content: policy });
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
    window.MotionPolicy.installMotionPreference();
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    const frames = await page.evaluate(async () => {
      document.documentElement.dataset.reducedMotion = "false";
      const samples: string[][] = [];
      for (let frame = 0; frame < 4; frame++) {
        await new Promise(requestAnimationFrame);
        samples.push(
          Array.from(
            document.querySelectorAll(
              ".application-settings-dialog, .application-settings-dialog__surface",
            ),
            (el) => getComputedStyle(el).opacity,
          ),
        );
      }
      return samples;
    });
    expect(frames.every((frame) => frame.every((opacity) => opacity === "1"))).toBe(true);
    await page.evaluate(() => {
      document.documentElement.dataset.reducedMotion = "true";
    });
  }
  await page.evaluate(async () => {
    document.documentElement.dataset.reducedMotion = "false";
    await new Promise(requestAnimationFrame);
    document.querySelector(".application-settings-dialog")!.remove();
    const dialog = document.createElement("div");
    dialog.className = "application-settings-dialog";
    dialog.innerHTML = '<section class="application-settings-dialog__surface">重新打开</section>';
    document.body.append(dialog);
  });
  expect(
    await page.evaluate(() =>
      document.getAnimations().some((animation) => animation.playState === "running"),
    ),
  ).toBe(true);
});
test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test("Chinese italic has a visibly different glyph shape without synthetic bold", async ({
  page,
}) => {
  await page.setContent(
    `<style>${appCss}\n#sample{width:400px;height:100px;background:white;color:black;font:48px 'PingFang SC','Microsoft YaHei',sans-serif}</style><div id="sample">中文斜体测试</div>`,
  );
  const sample = page.locator("#sample");
  const normal = await sample.screenshot();
  await sample.evaluate((el) => {
    el.innerHTML = "<em>中文斜体测试</em>";
  });
  const italic = await sample.screenshot();
  expect(italic.equals(normal)).toBe(false);
  expect(await sample.locator("em").evaluate((el) => getComputedStyle(el).fontSynthesis)).toBe(
    "style",
  );
});

test("app setting removes CSS animations, transitions and delays completely", async ({ page }) => {
  await page.setContent(
    `<style>${appCss}\n@keyframes probe{to{opacity:.5}}#sample{animation:probe 2s 8s infinite;transition:opacity 2s 8s}</style><div id="sample">文字</div>`,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  const style = await page.locator("#sample").evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      animation: s.animationName,
      transition: s.transitionProperty,
      delay: s.transitionDelay,
    };
  });
  expect(style).toEqual({ animation: "none", transition: "none", delay: "0s" });
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("turning reduction on finishes hidden-text paint and stops embedded effects", async ({
  page,
}) => {
  await page.setContent(
    '<div id="native">已提交文字</div><div id="ghost">动画文字</div><div id="host"></div><iframe srcdoc="<style>@keyframes spin{to{transform:rotate(360deg)}}p{animation:spin 1s infinite}</style><p>内嵌编辑器</p>"></iframe>',
  );
  await page.locator("iframe").evaluate(
    (el: HTMLIFrameElement) =>
      new Promise<void>((resolve) => {
        if (el.contentDocument?.readyState === "complete") resolve();
        else el.addEventListener("load", () => resolve(), { once: true });
      }),
  );
  await page.addScriptTag({ content: policy });
  await page.evaluate(() => {
    const shadow = document.querySelector("#host")!.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>@keyframes pulse{to{opacity:.5}}span{animation:pulse 1s infinite}</style><span>影子控件</span>";
    window.MotionPolicy.installMotionPreference();
    const native = document.querySelector("#native")!;
    const ghost = document.querySelector("#ghost")!;
    const animation = native.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 10000 });
    animation.onfinish = () => {
      animation.cancel();
      ghost.remove();
    };
    document.documentElement.dataset.reducedMotion = "true";
  });
  await expect(page.locator("#ghost")).toHaveCount(0);
  await expect(page.locator("#native")).toHaveCSS("opacity", "1");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        app: document.getAnimations().filter((a) => a.playState === "running").length,
        frame: document.querySelector("iframe")!.contentDocument!.getAnimations().length,
        shadow: getComputedStyle(
          document.querySelector("#host")!.shadowRoot!.querySelector("span")!,
        ).animationName,
      })),
    )
    .toEqual({ app: 0, frame: 0, shadow: "none" });
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "false";
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector("iframe")!.contentDocument!.getAnimations().length,
      ),
    )
    .toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  // An explicit application choice overrides the OS. Without an override,
  // embedded editors must follow the system preference too.
  expect(
    await page.evaluate(
      () => document.querySelector("iframe")!.contentDocument!.getAnimations().length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    delete document.documentElement.dataset.reducedMotion;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector("iframe")!.contentDocument!.getAnimations().length,
      ),
    )
    .toBe(0);
});

test("newly opened local editor surfaces inherit the disabled policy", async ({ page }) => {
  await page.setContent('<div id="surfaces"></div>');
  await page.addScriptTag({ content: policy });
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
    window.MotionPolicy.installMotionPreference();
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML =
      "<style>@keyframes pulse{to{opacity:.5}}span{animation:pulse 1s infinite}</style><span>新控件</span>";
    const frame = document.createElement("iframe");
    frame.srcdoc =
      "<style>@keyframes spin{to{opacity:.5}}p{animation:spin 1s infinite}</style><p>新编辑器</p>";
    document.querySelector("#surfaces")!.append(host, frame);
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.querySelector("#surfaces > div")!;
        const frame = document.querySelector("iframe")!;
        return [
          getComputedStyle(host.shadowRoot!.querySelector("span")!).animationName,
          frame.contentDocument?.documentElement.dataset.motionDisabled,
        ];
      }),
    )
    .toEqual(["none", "true"]);
});

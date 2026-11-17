import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { rendererDevelopmentOptions } = createRequire(import.meta.url)(
  "../../build/renderer-development.cjs",
);

test("Strict Mode chemical editors survive repeated sessions in two checkouts sharing dependencies", {
  timeout: 120000,
}, async () => {
  const primary = await mkdtemp(join(tmpdir(), "zxw-chemical-primary-"));
  const peer = await mkdtemp(join(tmpdir(), "zxw-chemical-peer-"));
  for (const checkout of [primary, peer]) {
    await symlink(join(root, "node_modules"), join(checkout, "node_modules"), "dir");
    await symlink(join(root, "src"), join(checkout, "src"), "dir");
  }
  const servers = [];
  let browser;
  try {
    for (const checkout of [primary, peer]) {
      const options = rendererDevelopmentOptions(checkout);
      const server = await createServer({
        ...options,
        configFile: false,
        root: join(checkout, "src/renderer"),
        plugins: [react()],
        resolve: {
          ...options.resolve,
          alias: {
            "ketcher-standalone": join(
              checkout,
              "node_modules/ketcher-standalone/dist/binaryWasm/main.js",
            ),
          },
        },
        server: {
          ...options.server,
          host: "127.0.0.1",
          port: 0,
          // The peer fixture lives in the source checkout; all dependency access
          // must come from the same options used by the actual developer server.
          fs: { allow: [...options.server.fs.allow, root] },
        },
        logLevel: "error",
      });
      servers.push(server);
      await server.listen();
    }
    assert.notEqual(servers[0].config.cacheDir, servers[1].config.cacheDir);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const [index, platform] of [
      [0, "win32"],
      [0, "darwin"],
      [0, "openharmony"],
      [1, "openharmony"],
    ]) {
      const server = servers[index];
      const port = server.httpServer.address().port;
      const page = await browser.newPage(
        platform === "darwin"
          ? {
              userAgent:
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
            }
          : {},
      );
      await page.addInitScript((p) => {
        globalThis.documentFontPlatform = p;
      }, platform);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("crash", () => errors.push("renderer crashed"));
      await page.goto(
        `http://127.0.0.1:${port}/@fs${root}/tests/e2e/fixtures/ketcher-runtime.html${index ? "?mode=macromolecule" : ""}`,
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.getByRole("button", { name: "打开结构式", exact: true }).click();
        await page.waitForFunction(
          () => !["loading", "closed"].includes(document.querySelector("output")?.textContent),
          undefined,
          { timeout: 35000 },
        );
        assert.equal(
          await page.getByLabel("运行状态").textContent(),
          "ready",
          JSON.stringify(errors),
        );
        if (index === 0 && attempt === 0) {
          const templates = page.locator('.ketcher-template-toolbar [data-testid="template-lib"]');
          const title = await templates.getAttribute("title");
          assert.match(title, platform === "darwin" ? /⇧\+T/ : /Shift\+T/);
          const dearom = page.locator(
            '[data-testid="top-toolbar"] [data-testid="Dearomatize button"]:visible',
          );
          assert.match(
            await dearom.getAttribute("title"),
            platform === "darwin" ? /⌃\+⌥\+A/ : /Ctrl\+Alt\+A/,
          );
          const integrationStyles = [];
          for (const stylesheet of [
            "app/app.css",
            "editor/editor.css",
            "chemistry/ketcher-editor.css",
            "shared/button-feedback.css",
          ]) {
            integrationStyles.push(
              await page.addStyleTag({
                content: await readFile(join(root, "src/renderer/src", stylesheet), "utf8"),
              }),
            );
          }
          await page
            .locator(".ketcher-editor-shell")
            .evaluate((e) => e.parentElement.classList.add("formula-dialog"));
          const verifyTemplateEdges = async () => {
            const geometry = await page.locator(".ketcher-template-toolbar").evaluate((e) => {
              const container = e.getBoundingClientRect();
              return [...e.querySelectorAll("button")]
                .filter((b) => b.getBoundingClientRect().height > 0)
                .map((b) => {
                  const box = b.getBoundingClientRect();
                  return { top: box.top - container.top, bottom: container.bottom - box.bottom };
                });
            });
            assert.ok(geometry.length > 0);
            assert.ok(
              geometry.every((box) => box.top >= 1 && box.bottom >= 1),
              JSON.stringify(geometry),
            );
          };
          await verifyTemplateEdges();
          const toolbar = page.locator('.ketcher-editor-shell [data-testid="top-toolbar"]:visible');
          const controls = await toolbar.evaluate((e) =>
            [...e.querySelectorAll("button")]
              .map((b) => ({ id: b.dataset.testid, rect: b.getBoundingClientRect() }))
              .filter((b) => b.rect.width > 0)
              .map((b) => ({ id: b.id, left: b.rect.left, right: b.rect.right })),
          );
          for (let i = 1; i < controls.length; i++) {
            assert.ok(
              controls[i].left >= controls[i - 1].right,
              `toolbar controls overlap: ${controls[i - 1].id}, ${controls[i].id}`,
            );
          }
          const copy = toolbar.locator('[data-testid="copy-button"]');
          const copyBox = await copy.boundingBox();
          for (const y of [
            copyBox.y + 2,
            copyBox.y + copyBox.height / 2,
            copyBox.y + copyBox.height - 2,
          ]) {
            await page.mouse.move(0, 0);
            await page.mouse.move(copyBox.x + copyBox.width / 2, y);
            await page.waitForFunction(
              () =>
                document
                  .querySelector('[data-testid="copy-button"]')
                  ?.hasAttribute("aria-describedby"),
              undefined,
              { timeout: 1000 },
            );
            assert.match(await page.getByRole("tooltip").textContent(), /复制/);
          }
          await page.mouse.move(0, 0);
          const host = page.locator(".ketcher-editor-shell");
          await host.evaluate((e) => (e.parentElement.style.width = "600px"));
          await verifyTemplateEdges();
          await page.screenshot({ path: "/private/tmp/template-edges-after.png" });
          await host.evaluate((e) => {
            e.parentElement.style.width = "1100px";
            e.parentElement.classList.remove("formula-dialog");
          });
          for (const style of integrationStyles) await style.evaluate((e) => e.remove());
          await page.addStyleTag({
            content: await readFile(
              join(root, "src/renderer/src/shared/button-feedback.css"),
              "utf8",
            ),
          });
          const action = page.locator(
            '.ketcher-editor-shell [data-testid="top-toolbar"] [data-testid="clear-canvas"]:visible',
          );
          const geometry = await action.evaluate((element) => ({
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            radius: getComputedStyle(element).borderRadius,
          }));
          assert.deepEqual(geometry, { width: 32, height: 32, radius: "6px" });
          const selected = page.locator(
            '.ketcher-editor-shell [data-testid="left-toolbar-buttons"] [data-testid="select-rectangle"]',
          );
          await page.waitForFunction(
            () =>
              getComputedStyle(
                document.querySelector(
                  '.ketcher-editor-shell [data-testid="left-toolbar-buttons"] [data-testid="select-rectangle"]',
                ),
              ).backgroundColor === "rgb(232, 241, 255)",
          );
          assert.equal(
            await selected.evaluate((element) => getComputedStyle(element).backgroundColor),
            "rgb(232, 241, 255)",
          );
          await selected.hover();
          await page.waitForTimeout(450);
          assert.equal(
            await selected.evaluate((e) => getComputedStyle(e).backgroundColor),
            "rgb(232, 241, 255)",
          );
          const more = page.getByRole("button", { name: "更多工具", exact: true });
          const topBefore = await action.boundingBox();
          await more.click();
          assert.equal(await more.getAttribute("aria-expanded"), "true");
          await page.getByTestId("reaction-plus").waitFor({ state: "visible" });
          await page.waitForTimeout(450);
          await page.locator('.ketcher-toolbar-extras [data-testid="reaction-plus"]').click();
          const topAfter = await action.boundingBox();
          assert.equal(topAfter.y, topBefore.y, "tool hints must not displace the canvas");
          await page.screenshot({ path: "/private/tmp/chemical-panel-after-20261006.png" });
          await more.click();
          assert.equal(
            await page.locator(".ketcher-toolbar-extras").evaluate((e) => e.inert),
            true,
          );
          await page.getByTestId("reaction-plus").waitFor({ state: "hidden" });
          await page.locator(".ketcher-editor-shell").evaluate((element) => {
            element.parentElement.style.width = "600px";
          });
          const shell = page.locator(".ketcher-editor-shell");
          assert.equal(
            await shell.evaluate((element) => element.scrollWidth <= element.clientWidth),
            true,
          );
          await page.screenshot({ path: "/private/tmp/chemical-panel-narrow-20261006.png" });
          await shell.evaluate((element) => {
            element.parentElement.style.width = "1100px";
          });
        }
        await page.getByRole("button", { name: "验证结构式数据", exact: true }).click();
        await page.waitForFunction(
          () =>
            !["ready", "loading-data", "reading-data"].includes(
              document.querySelector("output")?.textContent,
            ),
          undefined,
          { timeout: 35000 },
        );
        assert.equal(
          await page.getByLabel("运行状态").textContent(),
          "draft-ready",
          JSON.stringify(errors),
        );
        if (index === 0 && attempt === 0) {
          const oxygen = page
            .locator(".ketcher-editor-shell svg text")
            .filter({ hasText: /^O$/ })
            .last();
          await page
            .locator('[data-testid="left-toolbar-buttons"] [data-testid="select-rectangle"]')
            .click();
          await oxygen.dblclick();
          const properties = page.locator('[data-testid="info-modal-window"]:visible');
          await properties.waitFor({ state: "visible" });
          await page.screenshot({ path: "/private/tmp/chemical-atom-properties-after.png" });
          assert.ok((await properties.textContent()).includes("常规"));
          assert.equal(
            await properties.locator('input[type="button"]').first().inputValue(),
            "取消",
          );
          await properties.getByTestId("radical").getByRole("combobox").click();
          await page.getByRole("option", { name: "双自由基（单重态）", exact: true }).waitFor();
          await page.getByRole("option", { name: "双自由基（单重态）", exact: true }).click();
          await properties.getByTestId("Query specific-section").getByRole("button").click();
          await properties.getByTestId("Reaction flags-section").getByRole("button").click();
          assert.ok((await properties.textContent()).includes("查询条件"));
          assert.ok((await properties.textContent()).includes("构型变化"));
          assert.equal(await properties.getByTestId("OK").inputValue(), "应用");
          await page.screenshot({ path: `/private/tmp/chemical-atom-properties-${platform}.png` });
          await properties.getByTestId("Cancel").click();
          const line = await page.locator(".ketcher-editor-shell svg path").evaluateAll((es) => {
            const path = es.find((e) => {
              const b = e.getBoundingClientRect();
              return (
                Math.max(b.width, b.height) > 15 &&
                Math.max(b.width, b.height) < 300 &&
                Math.min(b.width, b.height) < 3 &&
                e.closest("svg")?.querySelector("text")
              );
            });
            if (!path) return null;
            const b = path.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          });
          assert.ok(line, "molecule must expose its bond stroke");
          await page.mouse.dblclick(line.x, line.y);
          await properties.waitFor({ state: "visible" });
          assert.ok((await properties.textContent()).includes("键属性"));
          await properties.getByTestId("type").getByRole("combobox").click();
          await page.getByRole("option", { name: "双键", exact: true }).click();
          assert.ok((await properties.textContent()).includes("双键"));
          await page.screenshot({ path: `/private/tmp/chemical-bond-properties-${platform}.png` });
          await properties.getByTestId("Cancel").click();
        }
        await page.getByRole("button", { name: "关闭结构式", exact: true }).click();
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await Promise.all(servers.map((server) => server.close()));
  }
});

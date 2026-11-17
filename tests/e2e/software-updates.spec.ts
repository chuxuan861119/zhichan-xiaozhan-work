import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

const execute = promisify(execFile);

test("hidden Electron: TLS update feed, nonmodal notice, settings, download and persisted opt-out", async ({
  workbench,
}) => {
  test.skip(
    process.env.PATENT_WORKBENCH_E2E_BACKGROUND !== "1",
    "Hidden isolated windows required",
  );
  const tlsRoot = await mkdtemp(join(tmpdir(), "update-tls-"));
  const cert = join(tlsRoot, "cert.pem");
  const key = join(tlsRoot, "key.pem");
  const config = join(tlsRoot, "openssl.cnf");
  await writeFile(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n",
  );
  await execute("/usr/bin/openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    key,
    "-out",
    cert,
    "-config",
    config,
  ]);
  let feedUrl = "";
  let requests = 0;
  let mode: "good" | "invalid" | "latest" = "good";
  const server = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    (request, response) => {
      requests++;
      expect(request.url).toBe("/stable.json");
      expect(request.method).toBe("GET");
      expect(request.headers.cookie).toBeUndefined();
      response.setHeader("Content-Type", "application/json");
      response.end(
        mode === "invalid"
          ? "bad json"
          : JSON.stringify({
              schemaVersion: 1,
              channel: "stable",
              releases: [
                {
                  version: mode === "latest" ? "1.1.1" : "1.2.0",
                  platform: process.platform,
                  arch: process.arch,
                  publishedAt: "2026-10-05T00:00:00Z",
                  notes: ["修复编辑器格式切换问题", "改善触摸板缩放体验", "更新 IPC 分类号数据库"],
                  classificationVersion: "2026.01",
                  systemRequirement: "macOS 14 及以上",
                  downloadUrl: feedUrl.replace("/stable.json", "/official-download"),
                },
              ],
            }),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("TLS server unavailable");
  feedUrl = `https://127.0.0.1:${address.port}/stable.json`;
  const previousFeed = process.env.PATENT_WORKBENCH_UPDATE_TEST_FEED;
  const previousCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.PATENT_WORKBENCH_UPDATE_TEST_FEED = feedUrl;
  process.env.NODE_EXTRA_CA_CERTS = cert;
  let application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    await dismissWorkbenchWelcome(page);
    await expect(
      page.getByRole("dialog", { name: "欢迎使用知产小栈Work", exact: true }),
    ).toBeHidden();
    await expect(page.locator(".standard-dialog-overlay[data-motion=exit]")).toHaveCount(0);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const notice = page.getByRole("complementary", { name: "新版本提醒" });
    await expect(notice).toBeVisible();
    expect(await page.getByRole("dialog", { name: "软件更新", exact: true }).count()).toBe(0);
    await expect(notice).toHaveCSS("opacity", "1");
    await page.screenshot({ path: test.info().outputPath("update-notice.png") });
    await notice.getByRole("button", { name: "查看更新" }).click();
    const update = page.getByRole("dialog", { name: "软件更新", exact: true });
    await expect(update).toContainText("新版本 1.2.0");
    await expect(update).toContainText("分类号数据库：2026.01");
    await expect(notice).toBeHidden();
    await expect(update).toHaveCSS("opacity", "1");
    await page.screenshot({ path: test.info().outputPath("update-details.png") });
    // Keep the test download in the isolated main process; never launch the user's browser.
    await application.evaluate(({ shell }) => {
      (globalThis as typeof globalThis & { updateOpened: string[] }).updateOpened = [];
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { updateOpened: string[] }).updateOpened.push(url);
      };
    });
    await update.getByRole("button", { name: "前往官方下载" }).click();
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as typeof globalThis & { updateOpened: string[] }).updateOpened,
        ),
      )
      .toEqual([feedUrl.replace("/stable.json", "/official-download")]);
    await update.getByRole("button", { name: "稍后提醒", exact: true }).click();
    await expect(update).toBeHidden();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(workbench.userData, "software-updates.json"), "utf8"))
            .postponedVersion,
      )
      .toBe("1.2.0");
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await page.getByRole("menuitem", { name: "检查更新", exact: true }).click();
    await expect(update).toContainText("新版本 1.2.0");
    await update.getByRole("button", { name: "跳过此版本" }).click();
    await expect(update).toBeHidden();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(workbench.userData, "software-updates.json"), "utf8"))
            .skippedVersion,
      )
      .toBe("1.2.0");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "软件更新", exact: true }).click();
    const automatic = settings.getByRole("checkbox", { name: "自动检查新版本" });
    await expect(automatic).toBeChecked();
    await automatic.uncheck();
    await expect(automatic).not.toBeChecked();
    await expect(automatic).toBeEnabled();
    await expect(settings.locator(".update-toggle > span")).toHaveCSS(
      "background-color",
      "rgb(192, 202, 217)",
    );
    const track = await settings.locator(".update-toggle > span").boundingBox();
    expect(track?.width).toBeGreaterThanOrEqual(30);
    expect(track?.height).toBeGreaterThanOrEqual(20);
    await page.screenshot({ path: test.info().outputPath("update-settings.png") });
    await settings.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(settings).toContainText("发现新版本 1.2.0");
    await settings.getByRole("button", { name: "查看新版本" }).click();
    await expect(update).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(update).toBeHidden();
    await expect(settings).toBeVisible();
    mode = "invalid";
    await settings.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(settings).toContainText("暂时无法检查更新");
    mode = "latest";
    await settings.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(settings).toContainText("当前已是最新稳定版本");
    expect(errors).toEqual([]);
    await application.close();
    const beforeRestart = requests;
    application = await workbench.launchAllowMultipleInstances();
    const reloaded = await application.firstWindow();
    await reloaded.getByRole("button", { name: "设置", exact: true }).click();
    const secondSettings = reloaded.getByRole("dialog", { name: "设置", exact: true });
    await secondSettings.getByRole("button", { name: "软件更新", exact: true }).click();
    await expect(
      secondSettings.getByRole("checkbox", { name: "自动检查新版本" }),
    ).not.toBeChecked();
    expect(requests).toBe(beforeRestart);
  } finally {
    await application.close().catch(() => {});
    if (previousFeed === undefined) delete process.env.PATENT_WORKBENCH_UPDATE_TEST_FEED;
    else process.env.PATENT_WORKBENCH_UPDATE_TEST_FEED = previousFeed;
    if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previousCa;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("hidden Electron: missing channel is explicit; help entry and Escape work", async ({
  workbench,
}) => {
  test.skip(
    process.env.PATENT_WORKBENCH_E2E_BACKGROUND !== "1",
    "Hidden isolated windows required",
  );
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await page.getByRole("menuitem", { name: "检查更新", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "软件更新", exact: true });
    await expect(dialog).toContainText("开发实例不检查正式更新渠道");
    await expect(dialog).not.toContainText("当前已是最新");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } finally {
    await app.close();
  }
});

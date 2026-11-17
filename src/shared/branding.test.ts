import { readFile } from "node:fs/promises";
import {
  APPLICATION_APP_ID,
  APPLICATION_DATA_DIRECTORY,
  APPLICATION_DOCUMENT_TYPE_NAME,
  APPLICATION_INTERNAL_NAME,
  APPLICATION_NAME,
  APPLICATION_VERSION,
} from "./branding.js";

test("defines one consistent public brand identity", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  expect(APPLICATION_NAME).toBe("知产小栈Work");
  expect(APPLICATION_DOCUMENT_TYPE_NAME).toBe("知产小栈专利文档");
  expect(APPLICATION_INTERNAL_NAME).toBe("zhichan-xiaozhan-work");
  expect(APPLICATION_APP_ID).toBe("cn.local.zhichanxiaozhanwork");
  expect(APPLICATION_DATA_DIRECTORY).toBe("ZhichanXiaozhanWork");
  expect(APPLICATION_VERSION).toBe(packageJson.version);

  const html = await readFile("src/renderer/index.html", "utf8");
  expect(html).toContain(`<title>${APPLICATION_NAME}</title>`);

  const builderConfiguration = await readFile("electron-builder.yml", "utf8");
  expect(builderConfiguration).toContain(`description: ${APPLICATION_DOCUMENT_TYPE_NAME}`);
});

test("vertically centers the library logo with its label", async () => {
  const css = await readFile("src/renderer/src/app/app.css", "utf8");
  expect(css).toMatch(
    /\.patent-tabs__library-tab\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/su,
  );
});

test("uses the official brand in user-facing native copy", async () => {
  const sources = await Promise.all(
    [
      "src/main/backup/backup-service.ts",
      "src/main/ipc/register-ipc.ts",
      "src/main/library/register-library-ipc.ts",
      "resources/licenses/sharp-libvips/LGPL_COMPLIANCE.md",
    ].map((path) => readFile(path, "utf8")),
  );

  for (const source of sources) {
    expect(source).not.toMatch(/(?<!知产小栈)专利工作台/u);
  }
});

test("sets the Electron runtime name without changing the existing user data directory", async () => {
  const mainEntry = await readFile("src/main/index.ts", "utf8");

  expect(mainEntry).toMatch(
    /const applicationUserDataPath =\s*tutorialSession\?\.userData \?\? canonicalSystemPath\(app\.getPath\("userData"\)\);\s*app\.setName\(APPLICATION_NAME\);[\s\S]*?if \(process\.platform === "win32"\) app\.setAppUserModelId\(APPLICATION_APP_ID\);\s*app\.setPath\("userData", applicationUserDataPath\);/u,
  );
});

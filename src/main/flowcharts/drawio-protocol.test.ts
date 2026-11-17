import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createDrawioProtocolHandler,
  DRAWIO_EDITOR_HOST,
  DRAWIO_EDITOR_SCHEME,
  resolveDrawioEditorRoot,
} from "./drawio-protocol.js";

async function responseFor(root: string, url: string): Promise<Response> {
  return createDrawioProtocolHandler(root)({ url } as Request);
}

describe("draw.io local protocol", () => {
  test("resolves installed Harmony resources even when its runtime reports unpackaged", () => {
    expect(
      resolveDrawioEditorRoot({
        isPackaged: false,
        platform: "openharmony",
        resourcesPath: "/bundle/resources",
        cwd: "/",
      }),
    ).toBe(resolve("/bundle/resources", "resources", "drawio", "app"));
  });
  test("resolves packaged resources from the extraResources destination", () => {
    expect(
      resolveDrawioEditorRoot({
        isPackaged: true,
        resourcesPath: "C:\\Program Files\\PatentWorkbench\\resources",
        cwd: "C:\\ignored",
      }),
    ).toBe(resolve("C:\\Program Files\\PatentWorkbench\\resources", "resources", "drawio", "app"));
  });

  let root: string;
  beforeEach(async () => {
    root = join(tmpdir(), `patent-drawio-protocol-${crypto.randomUUID()}`);
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "index.html"), "<html></html>");
    await writeFile(join(root, "nested", "editor.js"), "console.log('x')");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("serves only editor host files with a restrictive CSP", async () => {
    const response = await responseFor(
      root,
      `${DRAWIO_EDITOR_SCHEME}://${DRAWIO_EDITOR_HOST}/index.html`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors patent-app://app patent-diagram://editor",
    );
    expect(response.headers.get("content-type")).toContain("text/html");
  });
  test("allows the local development renderer to embed the editor when requested", async () => {
    const response = await createDrawioProtocolHandler(root, {
      allowDevelopmentFrameAncestors: true,
    })({
      url: `${DRAWIO_EDITOR_SCHEME}://${DRAWIO_EDITOR_HOST}/index.html`,
    } as Request);

    expect(response.headers.get("content-security-policy")).toContain(
      "http://localhost:* http://127.0.0.1:*",
    );
  });
  test("serves local draw.io language resources as text", async () => {
    await writeFile(join(root, "resources.txt"), "ok");
    const response = await responseFor(
      root,
      `${DRAWIO_EDITOR_SCHEME}://${DRAWIO_EDITOR_HOST}/resources.txt`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
  });
  test("cancels an empty resource without closing its stream twice", async () => {
    await writeFile(join(root, "empty.js"), "");
    const response = await responseFor(
      root,
      `${DRAWIO_EDITOR_SCHEME}://${DRAWIO_EDITOR_HOST}/empty.js`,
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const pendingRead = reader?.read();
    await Promise.resolve();
    await expect(reader?.cancel()).resolves.toBeUndefined();
    await expect(pendingRead).resolves.toMatchObject({ done: true });
  });
  test("serves the generated supplemental Chinese resource through the editor protocol", async () => {
    const editorRoot = join(process.cwd(), "resources", "drawio", "app");
    const response = await responseFor(
      editorRoot,
      `${DRAWIO_EDITOR_SCHEME}://${DRAWIO_EDITOR_HOST}/resources/patent_zh.txt`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toContain("diagram=流程图");
  });
  test.each([
    "patent-diagram://evil/index.html",
    "patent-diagram://editor/../secret.txt",
    "patent-diagram://editor/nested/unknown.exe",
    "https://editor/index.html",
    "patent-diagram://editor/%",
    "patent-diagram://editor/nested",
  ])("rejects an untrusted request %s", async (url) => {
    expect((await responseFor(root, url)).status).toBe(404);
  });
  test("does not follow a symbolic link outside the editor root", async () => {
    const secret = join(tmpdir(), `patent-drawio-secret-${crypto.randomUUID()}.js`);
    await writeFile(secret, "secret");
    try {
      await symlink(secret, join(root, "escaped.js"));
    } catch {
      return;
    }
    expect(
      (await responseFor(root, `${DRAWIO_EDITOR_SCHEME}://${DRAWIO_EDITOR_HOST}/escaped.js`))
        .status,
    ).toBe(404);
  });
});

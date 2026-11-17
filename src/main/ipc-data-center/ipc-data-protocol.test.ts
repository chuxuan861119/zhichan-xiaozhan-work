import { resolve } from "node:path";
import { createIpcDataProtocolHandler, resolveIpcDataRoot } from "./ipc-data-protocol.js";

test("uses installed Harmony resources instead of the runtime root cwd", () => {
  expect(
    resolveIpcDataRoot({
      isPackaged: false,
      platform: "openharmony",
      resourcesPath: "/bundle/resources",
      cwd: "/",
    }),
  ).toBe(resolve("/bundle/resources", "resources", "ipc-data-center"));
});

test("serves bundled data under its own origin and excludes application files", async () => {
  const handler = createIpcDataProtocolHandler(resolve("resources/ipc-data-center"));
  const response = await handler({ url: "patent-ipc://center/index.html" } as Request);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
  for (const url of [
    "patent-ipc://other/index.html",
    "patent-ipc://center/%2e%2e%2fpackage.json",
    "patent-ipc://center/index.html?remote=1",
    "https://center/index.html",
  ]) {
    expect((await handler({ url } as Request)).status).toBe(404);
  }
  expect(
    resolveIpcDataRoot({ isPackaged: true, resourcesPath: "C:/app/resources", cwd: "C:/unused" }),
  ).toBe(resolve("C:/app/resources/resources/ipc-data-center"));
});

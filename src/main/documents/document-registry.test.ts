import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentRegistry, normalizeDocumentPath } from "./document-registry.js";

test.skipIf(process.platform === "win32")(
  "POSIX document names retain case and literal backslashes",
  () => {
    expect(normalizeDocumentPath("/Users/test/First.patdoc")).not.toBe(
      normalizeDocumentPath("/Users/test/first.patdoc"),
    );
    expect(normalizeDocumentPath("/Users/test/a\\b.patdoc")).not.toBe(
      normalizeDocumentPath("/Users/test/a/b.patdoc"),
    );
  },
);

test.skipIf(process.platform === "win32")(
  "canonical POSIX file aliases share one open document and one save reservation",
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "patdoc-registry-")));
    const file = join(root, "original.patdoc");
    const alias = join(root, "alias.patdoc");
    writeFileSync(file, "fixture");
    symlinkSync(file, alias);
    const registry = new DocumentRegistry();
    registry.register("first", file);
    expect(registry.findSessionByPath(alias)).toBe("first");
    expect(() => registry.reserve("second", alias)).toThrow("已打开");
  },
);

test("Windows path spelling aliases share one open document and one save reservation", () => {
  const registry = new DocumentRegistry();
  registry.register("first", "C:\\patents\\Original.patdoc");
  expect(registry.findSessionByPath("c:/patents/original.patdoc")).toBe("first");
  expect(() => registry.reserve("second", "C:/patents/ORIGINAL.patdoc")).toThrow("已打开");
});

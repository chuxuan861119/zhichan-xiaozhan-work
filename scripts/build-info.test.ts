import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createBuildInfo, validateBuildPair } = createRequire(import.meta.url)(
  "../build/build-info.cjs",
);
const input = {
  version: "0.1.0",
  builtAt: "2026-09-07T08:00:00.123Z",
  commit: "a".repeat(40),
  dirty: false,
  mode: "production",
};

test("identifies build time, commit and dirty sources without changing the product version", () => {
  const info = createBuildInfo(input);
  expect(info.version).toBe("0.1.0");
  expect(info.buildId).toBe("20260907T080000123Z-aaaaaaaa");
  expect(createBuildInfo({ ...input, dirty: true }).buildId).toBe(`${info.buildId}-dirty`);
  expect(createBuildInfo({ ...input, builtAt: "2026-09-07T08:00:01.123Z" }).buildId).not.toBe(
    info.buildId,
  );
});

test("marks missing source provenance explicitly", () => {
  expect(createBuildInfo({ ...input, commit: null, dirty: null }).buildId).toContain(
    "source-unknown",
  );
});

test("packaging rejects missing, mixed, development and mismatched-version builds", () => {
  const info = createBuildInfo(input);
  expect(validateBuildPair(info, info, "0.1.0")).toEqual(info);
  for (const other of [
    null,
    { ...info, buildId: "different" },
    { ...info, commit: "b".repeat(40) },
  ]) {
    expect(() => validateBuildPair(info, other, "0.1.0")).toThrow();
  }
  const dev = createBuildInfo({ ...input, mode: "development" });
  expect(() => validateBuildPair(dev, dev, "0.1.0")).toThrow();
  expect(() => validateBuildPair(info, info, "0.2.0")).toThrow();
});

test("the actual packaging hook gives the installer the compiled build identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "patent-build-identity-"));
  const info = createBuildInfo(input);
  for (const sub of ["out/main", "out/renderer"]) {
    await mkdir(join(root, sub), { recursive: true });
    await writeFile(join(root, sub, "build-info.json"), JSON.stringify(info));
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ version: input.version }));
  const require = createRequire(import.meta.url);
  const beforePack = require("../build/build-info.cjs");
  const { expandMacro } = require("app-builder-lib/out/util/macroExpander.js");
  const previous = process.env.PATENT_BUILD_ID;
  try {
    process.env.PATENT_BUILD_ID = "untrusted-previous-build";
    await beforePack({ packager: { projectDir: root } });
    expect(
      expandMacro(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macro syntax
        "app-${version}-${env.PATENT_BUILD_ID}.${ext}",
        "x64",
        { version: input.version },
        { ext: "exe" },
      ),
    ).toBe(`app-0.1.0-${info.buildId}.exe`);
  } finally {
    if (previous === undefined) delete process.env.PATENT_BUILD_ID;
    else process.env.PATENT_BUILD_ID = previous;
  }
});

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// @ts-expect-error The executable MJS script exposes testable ESM exports without TypeScript declarations.
import { ALLOWED_LICENSES, generateThirdPartyNotices } from "../../../scripts/audit-licenses.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../..");

async function writePackage(
  root: string,
  path: string,
  manifest: Record<string, unknown>,
  licenseText?: string,
): Promise<void> {
  const directory = join(root, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  if (licenseText) await writeFile(join(directory, "LICENSE"), licenseText);
}

// The project-root checks hash the installed production tree, including the
// packaged native and WASM assets.  They are intentionally real filesystem
// audits, so they can exceed Vitest's five-second default while the full suite
// is running in parallel on Windows.
describe("production dependency license audit", { timeout: 15_000 }, () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "patent-license-audit-"));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  test("uses exactly the approved license policy", () => {
    expect([...ALLOWED_LICENSES]).toEqual([
      "MIT",
      "ISC",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "Apache-2.0",
      "0BSD",
      "Unlicense",
      "(MPL-2.0 OR Apache-2.0)",
      "MIT OR Apache-2.0",
      "BlueOak-1.0.0",
    ]);
  });

  test("includes full installed production license text and excludes dev dependencies", async () => {
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture", dependencies: { runtime: "1.2.3" } },
          "node_modules/runtime": { version: "1.2.3" },
          "node_modules/dev-only": { version: "9.9.9", dev: true },
        },
      }),
    );
    await writePackage(
      root,
      "node_modules/runtime",
      {
        name: "runtime",
        version: "1.2.3",
        license: "MIT",
        repository: { url: "https://example.invalid/runtime.git" },
      },
      "FULL RUNTIME LICENSE\nsecond line",
    );
    await writePackage(
      root,
      "node_modules/dev-only",
      { name: "dev-only", version: "9.9.9", license: "GPL-3.0" },
      "DEV LICENSE",
    );

    const notices = await generateThirdPartyNotices(root);

    expect(notices).toContain("runtime 1.2.3");
    expect(notices).toContain("License: MIT");
    expect(notices).toContain("Repository: https://example.invalid/runtime.git");
    expect(notices).toContain("FULL RUNTIME LICENSE\nsecond line");
    expect(notices).not.toContain("dev-only");
  });

  test("normalizes trailing whitespace from packaged license text", async () => {
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { runtime: "1.2.3" } },
          "node_modules/runtime": { version: "1.2.3" },
        },
      }),
    );
    await writePackage(
      root,
      "node_modules/runtime",
      { name: "runtime", version: "1.2.3", license: "MIT" },
      "MIT NOTICE  \nsecond line\t",
    );

    const notices = await generateThirdPartyNotices(root);

    expect(notices).toContain("MIT NOTICE\nsecond line");
    expect(notices).not.toContain("MIT NOTICE  \nsecond line\t");
  });

  test("fails with the exact package and version for a missing, disallowed, or textless license", async () => {
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { blocked: "4.5.6" } },
          "node_modules/blocked": { version: "4.5.6" },
        },
      }),
    );
    await writePackage(root, "node_modules/blocked", {
      name: "blocked",
      version: "4.5.6",
      license: "GPL-3.0-only",
    });

    await expect(generateThirdPartyNotices(root)).rejects.toThrow(
      "blocked@4.5.6: license GPL-3.0-only is prohibited for commercial distribution",
    );
  });

  test("records the Apache-2.0 selection for DOMPurify and MathJax license notice", async () => {
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: { dompurify: "3.4.11", "mathjax-full": "3.2.2" },
          },
          "node_modules/dompurify": { version: "3.4.11" },
          "node_modules/mathjax-full": { version: "3.2.2" },
        },
      }),
    );
    await writePackage(
      root,
      "node_modules/dompurify",
      {
        name: "dompurify",
        version: "3.4.11",
        license: "(MPL-2.0 OR Apache-2.0)",
      },
      "Apache License Version 2.0 DOMPurify",
    );
    await writePackage(
      root,
      "node_modules/mathjax-full",
      { name: "mathjax-full", version: "3.2.2", license: "Apache-2.0" },
      "Apache License Version 2.0 MathJax",
    );

    const notices = await generateThirdPartyNotices(root);
    expect(notices).toContain("DOMPurify license selection: Apache-2.0");
    expect(notices).toContain("MathJax Apache-2.0 notice");
    expect(notices).toContain("Apache License Version 2.0 MathJax");
  });

  test("audits only the Windows x64 production graph without hiding reachable violations", async () => {
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { runtime: "1.0.0" } },
          "node_modules/runtime": {
            version: "1.0.0",
            dependencies: { reachable: "1.0.0" },
            optionalDependencies: {
              "darwin-only": "1.0.0",
              "unrelated-wasm": "1.0.0",
            },
          },
          "node_modules/reachable": { version: "1.0.0" },
          "node_modules/darwin-only": {
            version: "1.0.0",
            optional: true,
            os: ["darwin"],
            cpu: ["x64"],
          },
          "node_modules/unrelated-wasm": { version: "1.0.0", optional: true },
          "node_modules/extraneous": { version: "1.0.0" },
        },
      }),
    );
    await writePackage(
      root,
      "node_modules/runtime",
      { name: "runtime", version: "1.0.0", license: "MIT" },
      "runtime MIT",
    );
    await writePackage(root, "node_modules/reachable", {
      name: "reachable",
      version: "1.0.0",
      license: "GPL-3.0-only",
      licenseText: "reachable GPL",
    });
    await writePackage(root, "node_modules/darwin-only", {
      name: "darwin-only",
      version: "1.0.0",
      license: "GPL-3.0-only",
      licenseText: "darwin GPL",
    });
    await writePackage(root, "node_modules/unrelated-wasm", {
      name: "unrelated-wasm",
      version: "1.0.0",
      license: "GPL-3.0-only",
      licenseText: "wasm GPL",
    });
    await writePackage(root, "node_modules/extraneous", {
      name: "extraneous",
      version: "1.0.0",
      license: "GPL-3.0-only",
      licenseText: "extraneous GPL",
    });

    await expect(generateThirdPartyNotices(root)).rejects.toThrow(
      "reachable@1.0.0: license GPL-3.0-only is prohibited for commercial distribution",
    );

    await writePackage(root, "node_modules/reachable", {
      name: "reachable",
      version: "1.0.0",
      license: "MIT",
      licenseText: "reachable MIT",
    });
    await expect(generateThirdPartyNotices(root)).rejects.toThrow(
      "unrelated-wasm@1.0.0: license GPL-3.0-only is prohibited for commercial distribution",
    );

    await writePackage(root, "node_modules/unrelated-wasm", {
      name: "unrelated-wasm",
      version: "1.0.0",
      license: "MIT",
      licenseText: "wasm MIT",
    });
    const notices = await generateThirdPartyNotices(root);
    expect(notices).toContain("unrelated-wasm 1.0.0");
    expect(notices).not.toContain("darwin-only");
    expect(notices).not.toContain("extraneous");
  });

  test("audits the nested package version actually resolved by its production parent", async () => {
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { parent: "1.0.0" } },
          "node_modules/parent": {
            version: "1.0.0",
            dependencies: { shared: "1.0.0" },
          },
          "node_modules/shared": { version: "2.0.0" },
          "node_modules/parent/node_modules/shared": { version: "1.0.0" },
        },
      }),
    );
    await writePackage(
      root,
      "node_modules/parent",
      { name: "parent", version: "1.0.0", license: "MIT" },
      "parent MIT",
    );
    await writePackage(
      root,
      "node_modules/shared",
      { name: "shared", version: "2.0.0", license: "MIT" },
      "hoisted MIT",
    );
    await writePackage(root, "node_modules/parent/node_modules/shared", {
      name: "shared",
      version: "1.0.0",
      license: "GPL-3.0-only",
      licenseText: "nested GPL",
    });

    await expect(generateThirdPartyNotices(root)).rejects.toThrow(
      "shared@1.0.0: license GPL-3.0-only is prohibited for commercial distribution",
    );
  });

  test("uses exact package-version policy selections and includes every selected license", async () => {
    const notices = await generateThirdPartyNotices(PROJECT_ROOT, {
      platform: process.platform,
      arch: process.arch,
    });

    expect(notices).toContain("jszip 3.10.2\nLicense: MIT (selected from dual license)");
    expect(notices).toContain("pako 1.0.11\nLicense: MIT AND Zlib");
    expect(notices).toContain("The zlib License");
    expect(notices).toContain("sax 1.6.1\nLicense: BlueOak-1.0.0");
    expect(notices).toContain("Blue Oak Model License");
    expect(notices).toContain("DOMPurify license selection: Apache-2.0");
    expect(notices).toContain("mj-context-menu Apache-2.0 notice");
  });

  test.runIf(process.platform === "win32")(
    "verifies curated official materials and the exact packaged sharp Windows bundle",
    async () => {
      const notices = await generateThirdPartyNotices(PROJECT_ROOT, {
        platform: process.platform,
        arch: process.arch,
      });

      for (const identity of [
        "@arnog/colors 0.5.0",
        "@tokenizer/token 0.3.0",
        "hash.js 1.1.7",
        "imurmurhash 0.1.4",
        "isarray 1.0.0",
        "mj-context-menu 0.6.1",
      ]) {
        expect(notices).toContain(identity);
        expect(notices).toMatch(
          new RegExp(
            `${identity.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]*Material SHA-256:`,
          ),
        );
        expect(notices).toMatch(
          new RegExp(
            `${identity.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]*Official source:`,
          ),
        );
      }
      expect(notices).not.toContain("<year> <copyright holders>");

      const manifest = JSON.parse(
        await readFile(
          join(PROJECT_ROOT, "resources/licenses/sharp-libvips/SOURCE_MANIFEST.json"),
          "utf8",
        ),
      ) as { dll: { path: string; sha256: string }; components: Record<string, [string, string]> };
      const binaryHash = createHash("sha256")
        .update(await readFile(join(PROJECT_ROOT, manifest.dll.path)))
        .digest("hex")
        .toUpperCase();
      expect(binaryHash).toBe(manifest.dll.sha256);
      expect(notices).toContain(`libvips-42.dll SHA-256: ${binaryHash}`);
      expect(notices).toContain("Reverse engineering for debugging modifications is permitted");
      expect(notices).toContain("Replace libvips-42.dll");
      for (const [component, [version]] of Object.entries(manifest.components)) {
        expect(notices).toContain(`${component} ${version}`);
      }
      const componentCount = Object.keys(manifest.components).length;
      expect(notices.match(/^SHARP COMPONENT LICENSE NOTICE: /gmu)).toHaveLength(componentCount);
      expect(notices.match(/^SHARP COMPONENT SOURCE: /gmu)).toHaveLength(componentCount);
      expect(notices).toContain("Alliance for Open Media Patent License 1.0");
      expect(notices).toContain("Cairo source license selection: LGPL-2.1-or-later");
      expect(notices).toContain("The FreeType Project LICENSE");
      expect(notices).toContain("PNG Reference Library License version 2");
      expect(notices).toContain("The build base image tag was not\npinned to an immutable digest");
      expect(notices).toContain("do not claim a\nbit-for-bit reproducible build");
    },
  );

  test("records fixed Ketcher and Indigo license material plus the packaged WASM assets", async () => {
    const notices = await generateThirdPartyNotices(PROJECT_ROOT, {
      platform: process.platform,
      arch: process.arch,
    });

    for (const identity of [
      "ketcher-core 3.17.1",
      "ketcher-react 3.17.1",
      "ketcher-standalone 3.17.1",
      "indigo-ketcher 1.45.0",
    ]) {
      expect(notices).toContain(identity);
    }
    expect(notices).toContain("KETCHER/INDIGO STATIC ASSETS");
    expect(notices).toContain(
      "indigo-ketcher-1.45.0.wasm SHA-256: 69F8593B9210E3FFABAB602FAA28280BB367221558557D0378718869A165AFFA",
    );
    expect(notices).toContain(
      "indigo-ketcher-norender-1.45.0.wasm SHA-256: FD60D063BCB377CB11309C90D9328ADAB1B5FBEAF08468D9F3BB64A77A6EA084",
    );
  });

  test("records Ketcher and Indigo upstream license materials plus fixed npm notice inventories", async () => {
    const notices = await generateThirdPartyNotices(PROJECT_ROOT, {
      platform: process.platform,
      arch: process.arch,
    });

    expect(notices).toContain("Ketcher upstream LICENSE (v3.17.1)");
    expect(notices).toContain(
      "Material SHA-256: 3D54B234FA88C11D1D96380FF5FE29F3C5D8E1078EF914DFE8185CE4B1FBEAC7",
    );
    expect(notices).toContain(
      "Source version: Ketcher git tag v3.17.1; Git blob c57051e763294433316ccfa5e189dac9c0cf8bc6",
    );
    expect(notices).toContain("Ketcher upstream NOTICE (v3.17.1)");
    expect(notices).toContain(
      "Material SHA-256: AB82986438FC66FA2B40836415B734FF018B1E42EE3A18434B27BDF1C42EB368",
    );
    expect(notices).toContain("ketcher-core@3.17.1 npm LICENSE/NOTICE files: none");
    expect(notices).toContain(
      "ketcher-core@3.17.1 package.json SHA-256: ADF45ED09BC1C8BF5F2377C25E603AFC14B9934191996A892C6CF9F9483ED7C0",
    );
    expect(notices).toContain("ketcher-react@3.17.1 npm LICENSE/NOTICE files: none");
    expect(notices).toContain("ketcher-standalone@3.17.1 npm LICENSE/NOTICE files: none");
    expect(notices).toContain("indigo-ketcher@1.45.0 npm LICENSE/NOTICE files: LICENSE");
    expect(notices).toContain(
      "indigo-ketcher@1.45.0 package LICENSE SHA-256: CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30",
    );
  });
});

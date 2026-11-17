import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bundledLicenseIndex,
  generateBundledResourceNotices,
  syncElectronLicenseMaterials,
} from "./audit-bundled-notices.mjs";
import { generateDocumentFontNotices } from "./audit-document-fonts.mjs";
import { auditDrawioBundle } from "./audit-drawio-bundle.mjs";

export const ALLOWED_LICENSES = new Set([
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

const LICENSE_FILE_PATTERN = /^(?:license|licence|copying)(?:$|[._-])/iu;

const PACKAGE_POLICIES = new Map(
  [
    [
      "@arnog/colors@0.5.0",
      "MIT",
      "MIT",
      [
        material(
          "npm/arnog-colors-0.5.0-MIT.txt",
          "C3B1B78BC8BD3EA13AA4BC9778442D16560270AFA235006D816E5E88CEF24DB4",
          "https://spdx.org/licenses/MIT.txt",
          "SPDX MIT canonical text",
        ),
      ],
      "The official npm package declares MIT but supplies neither a license file nor a copyright notice; no copyright holder is invented here.",
    ],
    [
      "@tokenizer/token@0.3.0",
      "MIT",
      "MIT",
      [
        material(
          "npm/tokenizer-token-0.3.0-MIT.txt",
          "2D92855FE0C91F754A34C19FB9976F1F28F2C6750054C3DA64BF419840264997",
          "https://registry.npmjs.org/@tokenizer/token/-/token-0.3.0.tgz#package/README.md",
          "npm 0.3.0 README license section",
        ),
      ],
    ],
    [
      "@napi-rs/canvas-win32-x64-msvc@1.0.10",
      "MIT",
      "MIT",
      [
        material(
          "npm/napi-rs-canvas-1.0.3-MIT.txt",
          "8802FECF9DA4367BC23BCF20B21CC143785FC6C92B152F3FA7FBE6CE08D344D6",
          "https://registry.npmjs.org/@napi-rs/canvas/-/canvas-1.0.10.tgz#package/LICENSE",
          "same-version parent package @napi-rs/canvas 1.0.10",
        ),
      ],
      "The platform binary package declares MIT but does not ship a standalone license file; the same-version parent package MIT license is bundled here.",
    ],
    [
      "hash.js@1.1.7",
      "MIT",
      "MIT",
      [
        material(
          "npm/hash.js-1.1.7-MIT.txt",
          "7261B3AB93DF04C6D8F3398F87275D28F0E87D88CBD0033B788FB50402DE03C5",
          "https://registry.npmjs.org/hash.js/-/hash.js-1.1.7.tgz#package/README.md",
          "npm 1.1.7 README license section",
        ),
      ],
    ],
    [
      "imurmurhash@0.1.4",
      "MIT",
      "MIT",
      [
        material(
          "npm/imurmurhash-0.1.4-MIT.txt",
          "2F3DE7CA97E07E9814E9A8DD61A561079AE6EB303579837E12D3D51F867EF7A6",
          "https://raw.githubusercontent.com/jensyt/imurmurhash-js/0.1.4/LICENSE",
          "official tag 0.1.4",
        ),
      ],
    ],
    [
      "isarray@1.0.0",
      "MIT",
      "MIT",
      [
        material(
          "npm/isarray-1.0.0-MIT.txt",
          "B05C56F1C665CD9E57DAE61865C8881344D7CBA85C7A8CB0D643A6EC03497F9D",
          "https://registry.npmjs.org/isarray/-/isarray-1.0.0.tgz#package/README.md",
          "npm 1.0.0 README license section",
        ),
      ],
    ],
    [
      "mj-context-menu@0.6.1",
      "Apache-2.0",
      "Apache-2.0",
      [
        material(
          "npm/mj-context-menu-0.6.1-Apache-2.0.txt",
          "CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30",
          "https://raw.githubusercontent.com/zorkow/context-menu/8ddd26a41f834cd23b9bb20737dfae5fa9b05eb4/doc/jsdoc/scripts/prettify/Apache-License-2.0.txt",
          "npm gitHead 8ddd26a41f834cd23b9bb20737dfae5fa9b05eb4",
        ),
      ],
      "mj-context-menu Apache-2.0 notice",
    ],
    [
      "jszip@3.10.2",
      "(MIT OR GPL-3.0-or-later)",
      "MIT (selected from dual license)",
      [
        material(
          "npm/jszip-3.10.1-LICENSE.markdown",
          "566C953C6090B1218CA6217DD7359D45DDE46581968586DC607D59A78AF6A9C4",
          "https://registry.npmjs.org/jszip/-/jszip-3.10.2.tgz#package/LICENSE.markdown",
          "npm 3.10.2; MIT section selected",
        ),
      ],
      undefined,
      "\n\nGPL version 3",
    ],
    [
      "pako@1.0.11",
      "(MIT AND Zlib)",
      "MIT AND Zlib",
      [
        material(
          "npm/pako-1.0.11-MIT.txt",
          "A04665B3B2DE56C66730C1F720F528175739E4104F79073614AA611DA1E85539",
          "https://registry.npmjs.org/pako/-/pako-1.0.11.tgz#package/LICENSE",
          "npm 1.0.11 MIT text",
        ),
        material(
          "npm/zlib-1.2.8-README.txt",
          "53A466B504371DCDDA1504C90D8121D4823921F03554C3526995FB2BAE7159F9",
          "https://raw.githubusercontent.com/madler/zlib/v1.2.8/README",
          "zlib 1.2.8 license notice",
          "The zlib License",
        ),
      ],
    ],
    [
      "sax@1.6.1",
      "BlueOak-1.0.0",
      "BlueOak-1.0.0",
      [
        material(
          "npm/sax-1.6.1-BlueOak.md",
          "8A1AF140FDFBF5AFD3DF27F7E662F989C5B963A300020DFAFCE42033CAE9E004",
          "https://registry.npmjs.org/sax/-/sax-1.6.1.tgz#package/LICENSE.md",
          "npm 1.6.1",
        ),
      ],
    ],
    [
      "dompurify@3.4.12",
      "(MPL-2.0 OR Apache-2.0)",
      "Apache-2.0",
      [
        material(
          "npm/Apache-2.0.txt",
          "CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30",
          "https://www.apache.org/licenses/LICENSE-2.0.txt",
          "Apache License 2.0 canonical text",
        ),
      ],
      "DOMPurify license selection: Apache-2.0",
    ],
    ["asap@1.0.0", "MIT", "MIT", [], "asap 1.0.0 declares MIT through its legacy licenses field."],
    [
      "eve-raphael@0.5.0",
      "",
      "Apache-2.0",
      [],
      "eve-raphael 0.5.0 has no package.json license field; its packaged LICENSE is Apache-2.0.",
    ],
    [
      "font-face-observer@1.0.0",
      "BSD",
      "BSD-2-Clause",
      [],
      "font-face-observer 1.0.0 declares BSD; its packaged LICENSE is the BSD 2-Clause text.",
    ],
    ["glob@13.0.6", "BlueOak-1.0.0", "BlueOak-1.0.0", []],
    ["lru-cache@11.5.2", "BlueOak-1.0.0", "BlueOak-1.0.0", []],
    ["minimatch@10.2.6", "BlueOak-1.0.0", "BlueOak-1.0.0", []],
    ["minipass@7.1.3", "BlueOak-1.0.0", "BlueOak-1.0.0", []],
    ["path-scurry@2.0.2", "BlueOak-1.0.0", "BlueOak-1.0.0", []],
    [
      "element-closest-polyfill@1.0.7",
      "ISC",
      "ISC",
      [
        material(
          "npm/ISC.txt",
          "2C3E7E1E754FFE61C36A5C5F1279F317017876E350FF164BD185FB79D5AB133A",
          "https://spdx.org/licenses/ISC.txt",
          "SPDX ISC canonical text",
        ),
      ],
      "element-closest-polyfill 1.0.7 declares ISC but does not ship a license file; the canonical ISC text is bundled here.",
    ],
    [
      "intersection-observer@0.12.2",
      "Apache-2.0",
      "Apache-2.0",
      [
        material(
          "npm/Apache-2.0.txt",
          "CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30",
          "https://www.apache.org/licenses/LICENSE-2.0.txt",
          "Apache License 2.0 canonical text",
        ),
      ],
      "intersection-observer 0.12.2 declares Apache-2.0 and does not ship a license file; the canonical Apache-2.0 text is bundled here.",
    ],
    [
      "remark-parse@9.0.0",
      "MIT",
      "MIT",
      [
        material(
          "npm/MIT-SPDX.txt",
          "C3B1B78BC8BD3EA13AA4BC9778442D16560270AFA235006D816E5E88CEF24DB4",
          "https://spdx.org/licenses/MIT.txt",
          "SPDX MIT canonical text",
        ),
      ],
      "remark-parse 9.0.0 declares MIT and does not ship a license file; the canonical MIT text is bundled here.",
    ],
    [
      "ketcher-core@3.17.1",
      "Apache-2.0",
      "Apache-2.0",
      [
        material(
          "ketcher/ketcher-3.17.1-LICENSE",
          "3D54B234FA88C11D1D96380FF5FE29F3C5D8E1078EF914DFE8185CE4B1FBEAC7",
          "https://raw.githubusercontent.com/epam/ketcher/v3.17.1/LICENSE",
          "Ketcher git tag v3.17.1; Git blob c57051e763294433316ccfa5e189dac9c0cf8bc6",
          "Ketcher upstream LICENSE (v3.17.1)",
        ),
      ],
      "Ketcher core 3.17.1 declares Apache-2.0. Its npm package supplies neither LICENSE nor NOTICE; the exact upstream v3.17.1 LICENSE is reproduced here.",
    ],
    [
      "ketcher-react@3.17.1",
      "Apache-2.0",
      "Apache-2.0",
      [
        material(
          "ketcher/ketcher-3.17.1-LICENSE",
          "3D54B234FA88C11D1D96380FF5FE29F3C5D8E1078EF914DFE8185CE4B1FBEAC7",
          "https://raw.githubusercontent.com/epam/ketcher/v3.17.1/LICENSE",
          "Ketcher git tag v3.17.1; Git blob c57051e763294433316ccfa5e189dac9c0cf8bc6",
          "Ketcher upstream LICENSE (v3.17.1)",
        ),
      ],
      "Ketcher React 3.17.1 declares Apache-2.0. Its npm package supplies neither LICENSE nor NOTICE; the exact upstream v3.17.1 LICENSE is reproduced here.",
    ],
    [
      "ketcher-standalone@3.17.1",
      "Apache-2.0",
      "Apache-2.0",
      [
        material(
          "ketcher/ketcher-3.17.1-LICENSE",
          "3D54B234FA88C11D1D96380FF5FE29F3C5D8E1078EF914DFE8185CE4B1FBEAC7",
          "https://raw.githubusercontent.com/epam/ketcher/v3.17.1/LICENSE",
          "Ketcher git tag v3.17.1; Git blob c57051e763294433316ccfa5e189dac9c0cf8bc6",
          "Ketcher upstream LICENSE (v3.17.1)",
        ),
      ],
      "Ketcher standalone 3.17.1 declares Apache-2.0. Its npm package supplies neither LICENSE nor NOTICE; the exact upstream v3.17.1 LICENSE is reproduced here.",
    ],
    [
      "indigo-ketcher@1.45.0",
      "Apache-2.0",
      "Apache-2.0",
      [
        material(
          "npm/Apache-2.0.txt",
          "CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30",
          "https://registry.npmjs.org/indigo-ketcher/-/indigo-ketcher-1.45.0.tgz#package/LICENSE",
          "npm package indigo-ketcher 1.45.0",
          "indigo-ketcher package LICENSE (npm 1.45.0)",
        ),
      ],
      "indigo-ketcher 1.45.0 supplies LICENSE and no NOTICE; its package LICENSE is reproduced here.",
    ],
    [
      "@img/sharp-win32-x64@0.35.5",
      "Apache-2.0 AND LGPL-3.0-or-later",
      "Apache-2.0 AND LGPL-3.0-or-later",
      [
        material(
          "sharp-libvips/licenses/Apache-2.0.txt",
          "DC1F5D2D43C5531DFE0ACAF4E950EA5DBE3E61E1850CF0E983BDA7EFC10D6693",
          "https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-0.35.5.tgz#package/LICENSE",
          "npm 0.35.5 Apache text",
        ),
        material(
          "sharp-libvips/licenses/GPL-3.0.txt",
          "3972DC9744F6499F0F9B2DBF76696F2AE7AD8AF9B23DDE66D6AF86C9DFB36986",
          "https://www.gnu.org/licenses/gpl-3.0.txt",
          "GNU GPL version 3",
        ),
        material(
          "sharp-libvips/licenses/LGPL-3.0.txt",
          "E3A994D82E644B03A792A930F574002658412F62407F5FEE083F2555C5F23118",
          "https://www.gnu.org/licenses/lgpl-3.0.txt",
          "GNU LGPL version 3",
        ),
      ],
      "Sharp Windows x64 Apache/LGPL notice; exact bundle details and Corresponding Source follow below",
    ],
  ].map(([identity, declaredLicense, selectedLicense, materials, notice, extractBefore]) => [
    identity,
    { declaredLicense, selectedLicense, materials, notice, extractBefore },
  ]),
);

for (const arch of ["arm64", "x64"]) {
  PACKAGE_POLICIES.set(
    `@napi-rs/canvas-darwin-${arch}@1.0.10`,
    PACKAGE_POLICIES.get("@napi-rs/canvas-win32-x64-msvc@1.0.10"),
  );
  const windowsPolicy = PACKAGE_POLICIES.get("@img/sharp-win32-x64@0.35.5");
  PACKAGE_POLICIES.set(`@img/sharp-libvips-darwin-${arch}@1.3.4`, {
    declaredLicense: "LGPL-3.0-or-later",
    selectedLicense: "LGPL-3.0-or-later",
    materials: windowsPolicy.materials.slice(1),
    notice: "Sharp macOS libvips; exact component sources and license notices follow below.",
  });
}

function material(path, sha256, sourceUrl, sourceVersion, heading) {
  return { path, sha256, sourceUrl, sourceVersion, heading };
}

const KETCHER_INDIGO_PACKAGE_INVENTORY = [
  {
    identity: "ketcher-core@3.17.1",
    manifestSha256: "ADF45ED09BC1C8BF5F2377C25E603AFC14B9934191996A892C6CF9F9483ED7C0",
    integrity:
      "sha512-fdeRW1faCAXscaahQ9E6mELf2sqpH0XZfwzWRfksJ+QmxQ+XCHWiwS2ezrdy94QzK7zg/fwBp1YdxkRmdAJsYg==",
    licenseNoticeFiles: [],
  },
  {
    identity: "ketcher-react@3.17.1",
    manifestSha256: "70FA72FA1D67C889A7AA63F24850ED1D804A7ECA6A226B36788CF3E76A5FCB90",
    integrity:
      "sha512-d7YaheanMq7d6E+lPWxwhASD5F5ort8lxDC0BBy/zNkXielqn2XauOr7C+ck+4OmqZk2EAVHn37+xQV2RoG7Rg==",
    licenseNoticeFiles: [],
  },
  {
    identity: "ketcher-standalone@3.17.1",
    manifestSha256: "EC90BEB47AB3687685BC39B578670755D591B36E56C53F7DCCF3B43B44FB873B",
    integrity:
      "sha512-djuj2dSJQsJrOic/ok0Xbp7sNrvQLYay2Y/IhFYnN1fQLf+2bo8wxIl9hagBhXJ+k+2TyyWcpvtm5no2dSxHvg==",
    licenseNoticeFiles: [],
  },
  {
    identity: "indigo-ketcher@1.45.0",
    manifestSha256: "FDFA9C51D068DC6576E9C3147FD467DE5F704C310A04925787E14B96539D5C86",
    integrity:
      "sha512-ilq2cZtB237g3lVC5ry1evk6TMmNxfLYevLxPO07aelTeKPCf9Tu1wnijiMsaOiGytAFJ2mU11wkroe1iHYfSg==",
    licenseNoticeFiles: ["LICENSE"],
    licenseSha256: "CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30",
  },
];

export async function generateThirdPartyNotices(
  rootDirectory,
  target = { platform: "win32", arch: "x64" },
) {
  const lock = JSON.parse(await readFile(join(rootDirectory, "package-lock.json"), "utf8"));
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json: packages map is missing");
  }

  const packages = [];
  const reachablePaths = productionPackagePaths(lock.packages, target);
  for (const [packagePath, lockEntry] of Object.entries(lock.packages)) {
    if (
      !packagePath ||
      !reachablePaths.has(packagePath) ||
      lockEntry?.dev === true ||
      lockEntry?.link === true ||
      !supportsTarget(lockEntry, target)
    )
      continue;
    const packageDirectory = join(rootDirectory, packagePath);
    const manifestPath = join(packageDirectory, "package.json");
    try {
      await access(manifestPath);
    } catch {
      if (lockEntry?.optional === true) continue;
      const fallbackName = packagePath.replace(/^.*node_modules[\\/]/u, "");
      throw new Error(
        `${fallbackName}@${String(lockEntry?.version ?? "unknown")}: package is not installed`,
      );
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const name = typeof manifest.name === "string" ? manifest.name : packagePath;
    const version =
      typeof manifest.version === "string"
        ? manifest.version
        : String(lockEntry?.version ?? "unknown");
    const identity = `${name}@${version}`;
    const license = declaredLicense(manifest);
    const policy = PACKAGE_POLICIES.get(identity);
    if (!license && !policy) throw new Error(`${identity}: license is missing`);
    if (policy && policy.declaredLicense !== license) {
      throw new Error(
        `${identity}: declared license changed from ${policy.declaredLicense} to ${license}`,
      );
    }
    if (!policy) assertLicenseAllowed(identity, license);
    const curatedMaterials = policy?.materials?.length
      ? await Promise.all(policy.materials.map((item) => readCuratedMaterial(rootDirectory, item)))
      : null;
    let licenseText = curatedMaterials
      ? curatedMaterials
          .map((item) => item.text)
          .join("\n\n")
          .split(policy.extractBefore ?? "\u0000", 1)[0]
      : await readLicenseText(packageDirectory, manifest.licenseText);
    if (!licenseText) throw new Error(`${identity}: license text is missing`);
    if (identity === "@arnog/colors@0.5.0" || identity === "remark-parse@9.0.0") {
      licenseText = licenseText.replace(/^Copyright \(c\) <year> <copyright holders>\r?\n?/mu, "");
    }
    if (identity === "element-closest-polyfill@1.0.7") {
      licenseText = licenseText.replace(/^Copyright \(c\) <year> <copyright holders>\r?\n?/mu, "");
    }
    licenseText = licenseText.replace(/[ \t]+$/gmu, "");
    if (!licenseText) throw new Error(`${identity}: license text is missing`);
    const packagedNotice = await readTopLevelNotice(packageDirectory, lockEntry);
    packages.push({
      name,
      version,
      license: policy?.selectedLicense ?? license,
      repository: repositoryUrl(manifest.repository),
      licenseText,
      notice: policy?.notice,
      materials: curatedMaterials,
      packagedNotice,
    });
  }

  packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en-US"),
  );
  const sections = packages.map((item) => {
    const specialNotice = item.notice
      ? `\n${item.notice}`
      : item.name === "dompurify"
        ? "\nDOMPurify license selection: Apache-2.0"
        : item.name === "mathjax-full"
          ? "\nMathJax Apache-2.0 notice"
          : "";
    const materialProvenance = item.materials?.length
      ? `\n${item.materials
          .map(
            (entry) =>
              `${entry.heading ? `${entry.heading}\n` : ""}Official source: ${entry.sourceUrl}\nSource version: ${entry.sourceVersion}\nMaterial SHA-256: ${entry.sha256}`,
          )
          .join("\n")}`
      : "";
    const packagedNotice = item.packagedNotice
      ? [
          "PACKAGED NOTICE",
          `Packaged source: ${item.packagedNotice.sourceUrl}`,
          `Packaged NOTICE SHA-256: ${item.packagedNotice.sha256}`,
          "--------------------------------------------------------------------------------",
          item.packagedNotice.text.trim(),
        ].join("\n")
      : "";
    return [
      "================================================================================",
      `${item.name} ${item.version}`,
      `License: ${item.license}`,
      `Repository: ${item.repository}${specialNotice}${materialProvenance}`,
      "--------------------------------------------------------------------------------",
      item.licenseText.trim(),
      packagedNotice,
    ].join("\n");
  });

  const sharpPackage =
    target.platform === "darwin" ? `sharp-libvips-darwin-${target.arch}` : "sharp-win32-x64";
  const sharpSection = reachablePaths.has(`node_modules/@img/${sharpPackage}`)
    ? await generateSharpBundleSection(rootDirectory, target)
    : null;
  const ketcherIndigoAssets = reachablePaths.has("node_modules/ketcher-standalone")
    ? await generateKetcherIndigoStaticAssetSection(rootDirectory, lock)
    : null;

  return [
    "THIRD-PARTY SOFTWARE NOTICES",
    "Generated from the installed production dependency tree. No legal warranty is implied.",
    `Target: ${target.platform}-${target.arch}`,
    "DOMPurify is used under the Apache License 2.0 option of its dual license.",
    "MathJax is distributed under the Apache License 2.0; its full license follows below.",
    "",
    ...sections,
    ...(sharpSection ? [sharpSection] : []),
    ...(ketcherIndigoAssets ? [ketcherIndigoAssets] : []),
    "",
  ]
    .join("\n")
    .replace(/\r\n?/g, "\n");
}

async function generateKetcherIndigoStaticAssetSection(rootDirectory, lock) {
  const base = join(rootDirectory, "node_modules", "ketcher-standalone", "dist");
  const assets = [
    [
      "binaryWasm/indigo-ketcher-1.45.0.wasm",
      "69F8593B9210E3FFABAB602FAA28280BB367221558557D0378718869A165AFFA",
    ],
    [
      "binaryWasm/indigo-ketcher-norender-1.45.0.wasm",
      "FD60D063BCB377CB11309C90D9328ADAB1B5FBEAF08468D9F3BB64A77A6EA084",
    ],
    [
      "binaryWasmNoRender/indigo-ketcher-1.45.0.wasm",
      "69F8593B9210E3FFABAB602FAA28280BB367221558557D0378718869A165AFFA",
    ],
    [
      "binaryWasmNoRender/indigo-ketcher-norender-1.45.0.wasm",
      "FD60D063BCB377CB11309C90D9328ADAB1B5FBEAF08468D9F3BB64A77A6EA084",
    ],
  ];
  const verifiedAssets = await Promise.all(
    assets.map(async ([path, expectedSha256]) => {
      const actualSha256 = createHash("sha256")
        .update(await readFile(join(base, path)))
        .digest("hex")
        .toUpperCase();
      if (actualSha256 !== expectedSha256) {
        throw new Error(`ketcher-standalone@3.17.1: ${path} SHA-256 changed`);
      }
      return `${path} SHA-256: ${actualSha256}`;
    }),
  );

  const upstreamNotice = await readCuratedMaterial(
    rootDirectory,
    material(
      "ketcher/ketcher-3.17.1-NOTICE",
      "AB82986438FC66FA2B40836415B734FF018B1E42EE3A18434B27BDF1C42EB368",
      "https://raw.githubusercontent.com/epam/ketcher/v3.17.1/NOTICE",
      "Ketcher git tag v3.17.1; Git blob d0ec08640a374ba503f497e72095ea1d2c1dedc0",
      "Ketcher upstream NOTICE (v3.17.1)",
    ),
  );
  const packageInventory = await verifyKetcherIndigoPackageInventory(rootDirectory, lock);

  return [
    "================================================================================",
    "KETCHER/INDIGO STATIC ASSETS",
    `${upstreamNotice.heading}\nOfficial source: ${upstreamNotice.sourceUrl}\nSource version: ${upstreamNotice.sourceVersion}\nMaterial SHA-256: ${upstreamNotice.sha256}`,
    "--------------------------------------------------------------------------------",
    upstreamNotice.text.trim(),
    "--------------------------------------------------------------------------------",
    "NPM package LICENSE/NOTICE inventories (fixed assertions against package-lock integrity and package.json SHA-256):",
    ...packageInventory,
    "--------------------------------------------------------------------------------",
    "Ketcher standalone 3.17.1 bundles the following Indigo 1.45.0 WebAssembly bytes.",
    "The source runtime package is indigo-ketcher 1.45.0 under Apache-2.0; its full packaged LICENSE appears above.",
    "These files are verified from the installed local package and are not fetched from a remote service.",
    ...verifiedAssets,
  ].join("\n");
}

async function verifyKetcherIndigoPackageInventory(rootDirectory, lock) {
  return Promise.all(
    KETCHER_INDIGO_PACKAGE_INVENTORY.map(async (expected) => {
      const [name, version] = expected.identity.split("@");
      const packagePath = `node_modules/${name}`;
      const lockEntry = lock.packages?.[packagePath];
      if (lockEntry?.version !== version || lockEntry.integrity !== expected.integrity) {
        throw new Error(`${expected.identity}: package-lock integrity changed`);
      }

      const packageDirectory = join(rootDirectory, packagePath);
      const manifestSha256 = createHash("sha256")
        .update(await readFile(join(packageDirectory, "package.json")))
        .digest("hex")
        .toUpperCase();
      if (manifestSha256 !== expected.manifestSha256) {
        throw new Error(`${expected.identity}: package.json SHA-256 changed`);
      }

      const files = await findLicenseNoticeFiles(packageDirectory);
      if (JSON.stringify(files) !== JSON.stringify(expected.licenseNoticeFiles)) {
        throw new Error(`${expected.identity}: LICENSE/NOTICE inventory changed`);
      }

      const lines = [
        `${expected.identity} package-lock integrity: ${expected.integrity}`,
        `${expected.identity} package.json SHA-256: ${manifestSha256}`,
        `${expected.identity} npm LICENSE/NOTICE files: ${files.join(", ") || "none"}`,
      ];
      if (expected.licenseSha256) {
        const licenseSha256 = createHash("sha256")
          .update(await readFile(join(packageDirectory, "LICENSE")))
          .digest("hex")
          .toUpperCase();
        if (licenseSha256 !== expected.licenseSha256) {
          throw new Error(`${expected.identity}: package LICENSE SHA-256 changed`);
        }
        lines.push(`${expected.identity} package LICENSE SHA-256: ${licenseSha256}`);
      }
      return lines;
    }),
  ).then((items) => items.flat());
}

async function findLicenseNoticeFiles(directory, relativePath = "") {
  const entries = await readdir(join(directory, relativePath), { withFileTypes: true });
  const found = await Promise.all(
    entries
      .filter((entry) => entry.name !== "node_modules")
      .map(async (entry) => {
        const path = join(relativePath, entry.name);
        if (entry.isDirectory()) return findLicenseNoticeFiles(directory, path);
        return /^(?:licen[cs]e|notice)(?:$|[._-])/iu.test(entry.name) ? [path] : [];
      }),
  );
  return found.flat().sort((left, right) => left.localeCompare(right, "en-US"));
}

async function generateSharpBundleSection(rootDirectory, target) {
  const suffix = target.platform === "darwin" ? `.darwin-${target.arch}` : "";
  const packageName =
    target.platform === "darwin" ? `sharp-libvips-darwin-${target.arch}` : "sharp-win32-x64";
  const base = join(rootDirectory, "resources", "licenses", "sharp-libvips");
  const manifest = JSON.parse(await readFile(join(base, `SOURCE_MANIFEST${suffix}.json`), "utf8"));
  const componentMaterials = JSON.parse(
    await readFile(join(base, `COMPONENT_MATERIALS${suffix}.json`), "utf8"),
  );
  const installedVersions = JSON.parse(
    await readFile(
      join(rootDirectory, "node_modules", "@img", packageName, "versions.json"),
      "utf8",
    ),
  );
  const expectedVersions = Object.fromEntries(
    Object.entries(manifest.components).map(([name, [version]]) => [name, version]),
  );
  if (
    JSON.stringify(Object.entries(installedVersions).sort()) !==
    JSON.stringify(Object.entries(expectedVersions).sort())
  ) {
    throw new Error(`${packageName}: versions.json does not match SOURCE_MANIFEST${suffix}.json`);
  }
  if (
    JSON.stringify(Object.keys(componentMaterials).sort()) !==
    JSON.stringify(Object.keys(manifest.components).sort())
  ) {
    throw new Error("Sharp component material keys do not match the installed component inventory");
  }
  const dllPath = join(rootDirectory, manifest.dll.path);
  const dllSha256 = createHash("sha256")
    .update(await readFile(dllPath))
    .digest("hex")
    .toUpperCase();
  if (dllSha256 !== manifest.dll.sha256) {
    throw new Error(
      `${manifest.dll.path}: SHA-256 ${dllSha256} does not match ${manifest.dll.sha256}`,
    );
  }
  for (const descriptor of [...manifest.buildSources, ...manifest.lgplCorrespondingSource]) {
    const filePath = join(base, descriptor.file);
    const sha256 = createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex")
      .toUpperCase();
    if (sha256 !== descriptor.sha256) {
      throw new Error(`${descriptor.file}: SHA-256 ${sha256} does not match ${descriptor.sha256}`);
    }
  }
  const componentSections = [];
  for (const [name, descriptor] of Object.entries(componentMaterials)) {
    const [archivePath, sourceUrl, expectedSha256] = descriptor.archive;
    const archiveSha256 = createHash("sha256")
      .update(await readFile(join(base, archivePath)))
      .digest("hex")
      .toUpperCase();
    if (archiveSha256 !== expectedSha256) {
      throw new Error(`${archivePath}: SHA-256 ${archiveSha256} does not match ${expectedSha256}`);
    }
    const materialSections = [];
    for (const [materialPath, materialSha256] of descriptor.materials) {
      const bytes = await readFile(join(base, materialPath));
      const actualSha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
      if (actualSha256 !== materialSha256) {
        throw new Error(
          `${materialPath}: SHA-256 ${actualSha256} does not match ${materialSha256}`,
        );
      }
      materialSections.push(
        `Material: ${materialPath}\nMaterial SHA-256: ${materialSha256}\n${bytes.toString("utf8").trim()}`,
      );
    }
    const [version, license] = manifest.components[name];
    componentSections.push(
      [
        `SHARP COMPONENT LICENSE NOTICE: ${name} ${version} — ${license}`,
        descriptor.notice ?? "",
        `SHARP COMPONENT SOURCE: ${sourceUrl}`,
        descriptor.transportMirror
          ? `Verified transport mirror: ${descriptor.transportMirror}`
          : "",
        `Source archive: ${archivePath}`,
        `Source archive SHA-256: ${expectedSha256}`,
        ...materialSections,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const compliance = await readFile(
    join(base, target.platform === "darwin" ? "LGPL_COMPLIANCE.macos.md" : "LGPL_COMPLIANCE.md"),
    "utf8",
  );
  const componentLines = Object.entries(manifest.components).map(
    ([name, [version, license]]) => `${name} ${version} — ${license}`,
  );
  const sourceLines = manifest.lgplCorrespondingSource.map(
    (item) =>
      `${item.name} ${item.version}\nOfficial source: ${item.url}\nSource archive SHA-256: ${item.sha256}`,
  );
  const buildLines = manifest.buildSources.map(
    (item) =>
      `${item.version} (${item.commit})\nOfficial source: ${item.url}\nSource archive SHA-256: ${item.sha256}`,
  );
  return [
    "================================================================================",
    `SHARP/LIBVIPS ${target.platform.toUpperCase()} ${target.arch.toUpperCase()} BUNDLE`,
    `${manifest.dll.path} SHA-256: ${dllSha256}`,
    "Actual bundled component inventory:",
    ...componentLines,
    "Complete component license, patent, copyright, and source notices:",
    ...componentSections,
    "LGPL Corresponding Source archives:",
    ...sourceLines,
    "Build and installation source archives:",
    ...buildLines,
    "--------------------------------------------------------------------------------",
    compliance.trim(),
  ].join("\n");
}

function productionPackagePaths(packages, target) {
  const reachable = new Set();
  const queue = [];
  enqueueDependencies(queue, packages, "", packages[""]);
  while (queue.length) {
    const packagePath = queue.shift();
    if (reachable.has(packagePath)) continue;
    const entry = packages[packagePath];
    if (!entry) {
      reachable.add(packagePath);
      continue;
    }
    if (!supportsTarget(entry, target)) continue;
    reachable.add(packagePath);
    enqueueDependencies(queue, packages, packagePath, entry);
  }
  return reachable;
}

function enqueueDependencies(queue, packages, parentPath, entry) {
  const required = Object.keys(entry?.dependencies ?? {});
  const optional = new Set(Object.keys(entry?.optionalDependencies ?? {}));
  for (const name of [...required, ...optional]) {
    const resolved = resolveDependencyPath(packages, parentPath, name);
    if (resolved || !optional.has(name)) queue.push(resolved ?? `node_modules/${name}`);
  }
}

function resolveDependencyPath(packages, parentPath, name) {
  let ancestor = parentPath;
  while (ancestor) {
    const candidate = `${ancestor}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const marker = ancestor.lastIndexOf("/node_modules/");
    ancestor = marker >= 0 ? ancestor.slice(0, marker) : "";
  }
  const rootCandidate = `node_modules/${name}`;
  return packages[rootCandidate] ? rootCandidate : null;
}

function supportsTarget(lockEntry, target) {
  return (
    matchesConstraint(lockEntry?.os, target.platform) &&
    matchesConstraint(lockEntry?.cpu, target.arch)
  );
}

function matchesConstraint(constraint, target) {
  if (!Array.isArray(constraint) || constraint.length === 0) return true;
  if (constraint.includes(`!${target}`)) return false;
  const positive = constraint.filter((item) => typeof item === "string" && !item.startsWith("!"));
  return positive.length === 0 || positive.includes(target);
}

function declaredLicense(manifest) {
  if (typeof manifest.license === "string") return manifest.license.trim();
  if (Array.isArray(manifest.licenses) && manifest.licenses.length === 1) {
    const [legacyLicense] = manifest.licenses;
    if (legacyLicense && typeof legacyLicense.type === "string") return legacyLicense.type.trim();
  }
  return "";
}

export function assertLicenseAllowed(identity, license) {
  const normalized = typeof license === "string" ? license.trim() : "";
  if (!normalized || /^unknown$/iu.test(normalized)) {
    throw new Error(`${identity}: license is missing or unknown`);
  }
  if (
    /(?:^|[^A-Z])(?:A?GPL(?:-|\b)|CC-BY-NC(?:-|\b)|NON-?COMMERCIAL\b|PROPRIETARY\b)/iu.test(
      normalized,
    )
  ) {
    throw new Error(`${identity}: license ${normalized} is prohibited for commercial distribution`);
  }
  if (!ALLOWED_LICENSES.has(normalized)) {
    throw new Error(`${identity}: license ${normalized} is not allowed`);
  }
}

async function readCuratedMaterial(rootDirectory, descriptor) {
  const path = join(rootDirectory, "resources", "licenses", descriptor.path);
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  const normalizedLf = text.replace(/\r\n/g, "\n");
  const variants = [
    bytes,
    Buffer.from(normalizedLf),
    Buffer.from(normalizedLf.replace(/\n/g, "\r\n")),
  ];
  const hashes = variants.map((variant) =>
    createHash("sha256").update(variant).digest("hex").toUpperCase(),
  );
  const sha256 = hashes[0];
  if (!hashes.includes(descriptor.sha256)) {
    throw new Error(`${descriptor.path}: SHA-256 ${sha256} does not match ${descriptor.sha256}`);
  }
  return { ...descriptor, text };
}

export async function auditLicenses(
  rootDirectory = process.cwd(),
  target = { platform: process.platform, arch: process.arch },
) {
  try {
    await auditDrawioBundle(rootDirectory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "draw.io bundle is missing; run npm run vendor:drawio before npm run audit:licenses.",
      );
    }
    throw error;
  }
  await syncElectronLicenseMaterials(rootDirectory);
  const outputPath = join(rootDirectory, "resources", "THIRD_PARTY_NOTICES.txt");
  const notices =
    (await generateThirdPartyNotices(rootDirectory, target)) +
    (await generateDocumentFontNotices(rootDirectory)) +
    (await generateBundledResourceNotices(rootDirectory));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, notices, "utf8");
  await writeFile(
    join(rootDirectory, "resources/licenses/INDEX.md"),
    bundledLicenseIndex(),
    "utf8",
  );
  return outputPath;
}

async function readLicenseText(packageDirectory, manifestLicenseText) {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort(
      (left, right) =>
        licenseFileScore(left) - licenseFileScore(right) || left.localeCompare(right, "en-US"),
    );
  const selected = candidates[0];
  if (selected) return readFile(join(packageDirectory, selected), "utf8");
  return typeof manifestLicenseText === "string" && manifestLicenseText.trim()
    ? manifestLicenseText
    : null;
}

async function readTopLevelNotice(packageDirectory, lockEntry) {
  const noticePath = join(packageDirectory, "NOTICE");
  let bytes;
  try {
    bytes = await readFile(noticePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const text = bytes.toString("utf8").replace(/[ \t]+$/gmu, "");
  if (!text.trim()) return null;
  const packageUrl = typeof lockEntry?.resolved === "string" ? lockEntry.resolved : "not provided";
  return {
    text,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    sourceUrl: `${packageUrl}#package/NOTICE`,
  };
}

function licenseFileScore(name) {
  return /^(?:license|licence|copying)$/iu.test(name) ? 0 : 1;
}

function repositoryUrl(repository) {
  if (typeof repository === "string" && repository.trim()) return repository;
  if (repository && typeof repository.url === "string" && repository.url.trim()) {
    return repository.url;
  }
  return "not provided";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  await auditLicenses(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}

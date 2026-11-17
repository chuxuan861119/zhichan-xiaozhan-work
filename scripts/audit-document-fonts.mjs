import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MATERIALS = [
  [
    "src/shared/document/fonts/SourceHanSerifCN-Regular.otf",
    "3754ea669c530e2473354f8f6d9f79680a44d7e26ec7d00eeabee4a7e0753c5d",
  ],
  [
    "src/shared/document/fonts/SourceHanSerifCN-SemiBold.otf",
    "50d3f12201ce2dd840650b6bfa47ebb8572ecf767eec0e5ccb20a247b5bfa805",
  ],
  [
    "resources/licenses/source-han-serif/LICENSE.txt",
    "9ff5bb567e1b92c801fc1069e5fbf992ff8efccacb9db94e5959a5b3ba9bb903",
  ],
];

export async function generateDocumentFontNotices(rootDirectory) {
  for (const [path, expected] of MATERIALS) {
    const actual = createHash("sha256")
      .update(await readFile(join(rootDirectory, path)))
      .digest("hex");
    if (actual !== expected) throw new Error(`${path}: bundled font/license SHA-256 mismatch`);
  }
  return [
    "\nSystem document fonts: Windows SimSun/FangSong/KaiTi, HarmonyOS Sans SC, and macOS system fonts are referenced from the local operating system only. Rights remain with their respective owners. No system font files are redistributed with this application or embedded in DOCX exports.",
    "\nSource Han Serif CN 2.003 — Regular and SemiBold",
    "License: SIL Open Font License 1.1",
    "macOS PDF/print uses temporary ZXWPrintSerif derivatives of these bundled fonts with unambiguous Unicode mappings. Original outlines, metrics, copyright and OFL metadata are retained; reserved font names are replaced. Editor fonts and the distributed original font files remain unchanged.",
    "Source: https://github.com/adobe-fonts/source-han-serif/tree/7889f11bf31170b5d092a083b357c8c8130f89e0/SubsetOTF/CN",
    ...MATERIALS.map(([path, hash]) => `${path} SHA-256: ${hash}`),
    await readFile(join(rootDirectory, "resources/licenses/source-han-serif/LICENSE.txt"), "utf8"),
  ].join("\n");
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { MAX_KET_SOURCE_BYTES } from "../../shared/document/model.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { readPatdoc } from "../documents/patdoc-reader.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import {
  rasterizeChemicalStructureAsset,
  validateChemicalPreviewSvg,
} from "./chemical-preview-service.js";
import { embedChemicalStructureSource, readChemicalStructureSource } from "./structure-source.js";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="76" height="87"><path d="M10 20H60" stroke="black"/></svg>';
const source = {
  ketSource:
    '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule","atoms":[{"label":"No"}],"bonds":[]}}',
  editorMode: "molecule" as const,
};

test("round-trips exact scientific source in safe SVG metadata and separates equal-looking assets", async () => {
  const first = await rasterizeChemicalStructureAsset(svg, source);
  expect(
    readChemicalStructureSource(
      validateChemicalPreviewSvg(Buffer.from(first.original).toString("utf8")),
    ),
  ).toEqual(source);
  const second = await rasterizeChemicalStructureAsset(svg, {
    ...source,
    ketSource: source.ketSource.replace("No", "C"),
  });
  expect(second.descriptor.sha256).not.toBe(first.descriptor.sha256);
  expect(second.preview).toEqual(first.preview);
  expect(readChemicalStructureSource(svg)).toBeNull();
});

test("preserves editable drawing sources through a real PATDOC export and import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chemical-source-roundtrip-"));
  try {
    const asset = await rasterizeChemicalStructureAsset(svg, source);
    const patent = createBlankPatent({ patentType: "invention", name: "结构源数据回归" });
    patent.assets = [asset.descriptor];
    patent.figures = [
      {
        figureId: "00000000-0000-4000-8000-000000000111",
        assetId: asset.descriptor.assetId,
        widthMm: 42,
        rotationDeg: 90,
      },
    ];
    patent.abstractDrawingFigureId = patent.figures[0]!.figureId;
    const path = join(directory, "structure.patdoc");
    await writePatdoc(path, { patent, assets: [asset] });
    const restored = await readPatdoc<PatentPatdocPayload>(path);
    expect(restored.patent.figures).toEqual(patent.figures);
    expect(
      readChemicalStructureSource(Buffer.from(restored.assets[0]!.original).toString("utf8")),
    ).toEqual(source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed and oversized compressed source instead of silently losing editability", () => {
  const encoded = deflateSync(Buffer.from("x".repeat(MAX_KET_SOURCE_BYTES + 1))).toString("base64");
  const packet = `<metadata id="patent-workbench-chemical-source" data-encoding="ket-zlib-v1" data-editor-mode="molecule">${encoded}</metadata>`;
  expect(() => readChemicalStructureSource(svg.replace("</svg>", `${packet}</svg>`))).toThrow();
  const embedded = embedChemicalStructureSource(svg, source);
  expect(() => readChemicalStructureSource(embedded.replace("ket-zlib-v1", "unknown"))).toThrow();
  expect(() =>
    embedChemicalStructureSource(svg, { ketSource: " ", editorMode: "molecule" }),
  ).toThrow();
});

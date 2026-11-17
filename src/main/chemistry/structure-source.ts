import { deflateSync, inflateSync } from "node:zlib";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import {
  type ChemicalStructureSource,
  ChemicalStructureSourceSchema,
} from "../../shared/chemistry/structure-source.js";
import { MAX_KET_SOURCE_BYTES } from "../../shared/document/model.js";

const SOURCE_ID = "patent-workbench-chemical-source";
const SOURCE_ENCODING = "ket-zlib-v1";
const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG metadata travels with the existing immutable asset through save, undo and PATDOC. */
export function embedChemicalStructureSource(svg: string, source: ChemicalStructureSource): string {
  const validated = ChemicalStructureSourceSchema.parse(source);
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  for (const metadata of Array.from(document.getElementsByTagNameNS(SVG_NS, "metadata"))) {
    if (metadata.getAttribute("id") === SOURCE_ID) metadata.parentNode?.removeChild(metadata);
  }
  const metadata = document.createElementNS(SVG_NS, "metadata");
  metadata.setAttribute("id", SOURCE_ID);
  metadata.setAttribute("data-encoding", SOURCE_ENCODING);
  metadata.setAttribute("data-editor-mode", validated.editorMode ?? "molecule");
  metadata.appendChild(
    document.createTextNode(
      deflateSync(Buffer.from(validated.ketSource, "utf8")).toString("base64"),
    ),
  );
  document.documentElement!.appendChild(metadata);
  return new XMLSerializer().serializeToString(document);
}

/** Call only after SVG validation; decoding is bounded independently from the compressed size. */
export function readChemicalStructureSource(svg: string): ChemicalStructureSource | null {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const entries = Array.from(document.getElementsByTagNameNS(SVG_NS, "metadata")).filter(
    (entry) => entry.getAttribute("id") === SOURCE_ID,
  );
  if (entries.length === 0) return null;
  if (entries.length !== 1) throw new Error("结构源数据重复。");
  const metadata = entries[0]!;
  const encoded = metadata.textContent ?? "";
  if (
    metadata.getAttribute("data-encoding") !== SOURCE_ENCODING ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded) ||
    !encoded
  ) {
    throw new Error("结构源数据编码无效。");
  }
  const bytes = inflateSync(Buffer.from(encoded, "base64"), {
    maxOutputLength: MAX_KET_SOURCE_BYTES,
  });
  const ketSource = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return ChemicalStructureSourceSchema.parse({
    ketSource,
    editorMode: metadata.getAttribute("data-editor-mode"),
  });
}

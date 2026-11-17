import { extname, parse as parsePath } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import {
  FLOWCHART_MAX_DECOMPRESSED_XML_BYTES,
  FLOWCHART_MAX_PAGES,
  FLOWCHART_MAX_SOURCE_XML_BYTES,
} from "../../shared/flowcharts/limits.js";

const MAX_OBJECTS = 50_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const XML_DECLARATION = /^\s*<\?xml[^>]*>\s*/iu;
const ACTIVE_XML = /<!DOCTYPE|<!ENTITY|<script\b|\son[a-z]+\s*=/iu;
const REMOTE_URI = /(?:https?|ftp|ftps|file|ws|wss):\/\//iu;

export type FlowchartImportErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "CORRUPT_FILE"
  | "UNSAFE_XML"
  | "REMOTE_RESOURCE"
  | "SOURCE_TOO_LARGE"
  | "TOO_MANY_PAGES"
  | "TOO_MANY_OBJECTS"
  | "MIME_MISMATCH";

export class FlowchartImportError extends Error {
  constructor(
    readonly code: FlowchartImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ParsedFlowchartImport = Readonly<{
  name: string;
  source: Uint8Array;
  pageCount: number;
  lastPageId: string | null;
  kind: "editable" | "flattened";
}>;

type ImportFile = Readonly<{ name: string; bytes: Uint8Array }>;

function fail(code: FlowchartImportErrorCode, message: string): never {
  throw new FlowchartImportError(code, message);
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  );
}

function decodeCompressed(value: string): string | null {
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = Buffer.from(normalized, "base64");
    const inflated = inflateRawSync(binary, {
      maxOutputLength: FLOWCHART_MAX_DECOMPRESSED_XML_BYTES,
    }).toString("utf8");
    try {
      return decodeURIComponent(inflated.replace(/\+/gu, "%20"));
    } catch {
      return inflated;
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
    )
      fail("SOURCE_TOO_LARGE", "流程图解压后的内容过大。");
    return null;
  }
}

function extractPngSource(bytes: Uint8Array): string | null {
  if (!isPng(bytes)) return null;
  const buffer = Buffer.from(bytes);
  for (let offset = 8; offset + 12 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) fail("CORRUPT_FILE", "PNG 文件结构已损坏。");
    const data = buffer.subarray(dataStart, dataEnd);
    const separator = data.indexOf(0);
    if ((type === "tEXt" || type === "zTXt") && separator >= 0) {
      const keyword = data.toString("latin1", 0, separator);
      if (keyword === "mxGraphModel") {
        if (type === "tEXt") return data.toString("utf8", separator + 1);
        if (data[separator + 1] !== 0) fail("CORRUPT_FILE", "PNG 流程图压缩方式不受支持。");
        try {
          return inflateSync(data.subarray(separator + 2), {
            maxOutputLength: FLOWCHART_MAX_DECOMPRESSED_XML_BYTES,
          }).toString("utf8");
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ERR_BUFFER_TOO_LARGE"
          )
            fail("SOURCE_TOO_LARGE", "PNG 内嵌流程图解压后的内容过大。");
          fail("CORRUPT_FILE", "PNG 内嵌流程图源已损坏。");
        }
      }
    }
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }
  return null;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&");
}

function extractSvgSource(svg: string): string | null {
  const match = svg.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/iu);
  if (!match?.[2]) return null;
  const value = decodeHtmlAttribute(match[2]);
  if (value.includes("<mxfile") || value.includes("<mxGraphModel")) return value;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("<mxfile") || decoded.includes("<mxGraphModel")) return decoded;
  } catch {
    // The compressed draw.io form is not a URI by itself.
  }
  return decodeCompressed(value);
}

function assertNoRemoteResources(value: string): void {
  const withoutNamespaces = value.replace(
    /https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|XML\/1998\/namespace)/giu,
    "",
  );
  if (REMOTE_URI.test(withoutNamespaces)) {
    fail("REMOTE_RESOURCE", "流程图包含外部资源地址，无法离线导入。");
  }
}

function parseXml(value: string) {
  if (ACTIVE_XML.test(value)) fail("UNSAFE_XML", "流程图包含不安全的 XML 内容。");
  assertNoRemoteResources(value);
  try {
    return new DOMParser({
      onError: () => {
        throw new Error("Invalid XML");
      },
    }).parseFromString(value, "text/xml");
  } catch {
    fail("CORRUPT_FILE", "流程图 XML 内容已损坏。");
  }
}

function validateXml(sourceInput: string): Omit<ParsedFlowchartImport, "name" | "kind"> {
  const source = sourceInput.replace(XML_DECLARATION, "").trim();
  const encoded = new TextEncoder().encode(source);
  if (encoded.byteLength === 0) fail("CORRUPT_FILE", "流程图源文件为空。");
  if (encoded.byteLength > FLOWCHART_MAX_SOURCE_XML_BYTES)
    fail("SOURCE_TOO_LARGE", "流程图源文件超过 20 MiB。");
  if (ACTIVE_XML.test(source)) fail("UNSAFE_XML", "流程图包含不安全的 XML 内容。");
  assertNoRemoteResources(source);
  let normalized = source;
  if (/^<mxGraphModel\b/iu.test(source)) {
    normalized = `<mxfile><diagram id="page-1" name="第1页">${source}</diagram></mxfile>`;
  }
  if (!/^<mxfile\b/iu.test(normalized) || !/<\/mxfile>\s*$/iu.test(normalized)) {
    fail("CORRUPT_FILE", "文件不是有效的 draw.io 工程。");
  }
  const document = parseXml(normalized);
  const root = document.documentElement;
  if (root?.tagName !== "mxfile") fail("CORRUPT_FILE", "文件不是有效的 draw.io 工程。");
  const diagrams = Array.from(root.childNodes).filter((node) => node.nodeType === 1);
  if (diagrams.length === 0) fail("CORRUPT_FILE", "流程图工程没有页面。");
  if (diagrams.length > FLOWCHART_MAX_PAGES) fail("TOO_MANY_PAGES", "流程图页面数量过多。");
  let objectCount = 0;
  let expandedBytes = 0;
  const pageIds = new Set<string>();
  for (const node of diagrams) {
    const diagram = node as import("@xmldom/xmldom").Element;
    if (diagram.tagName !== "diagram") fail("CORRUPT_FILE", "流程图页面结构无效。");
    const id = diagram.getAttribute("id");
    if (id && pageIds.has(id)) fail("CORRUPT_FILE", "流程图页面编号重复。");
    if (id) pageIds.add(id);
    const children = Array.from(diagram.childNodes).filter((child) => child.nodeType === 1);
    const xml =
      children.length === 1 && children[0]
        ? new XMLSerializer().serializeToString(children[0])
        : children.length === 0
          ? decodeCompressed(diagram.textContent ?? "")
          : null;
    if (!xml) fail("CORRUPT_FILE", "流程图页面内容已损坏。");
    expandedBytes += Buffer.byteLength(xml, "utf8");
    if (expandedBytes > FLOWCHART_MAX_DECOMPRESSED_XML_BYTES)
      fail("SOURCE_TOO_LARGE", "流程图解压后的内容过大。");
    const model = parseXml(xml);
    if (model.documentElement?.tagName !== "mxGraphModel")
      fail("CORRUPT_FILE", "流程图页面内容无效。");
    objectCount += model.getElementsByTagName("mxCell").length;
    if (objectCount > MAX_OBJECTS) fail("TOO_MANY_OBJECTS", "流程图对象数量过多。");
  }
  const pageId = (diagrams[0] as import("@xmldom/xmldom").Element).getAttribute("id") || null;
  return {
    source: new TextEncoder().encode(normalized),
    pageCount: diagrams.length,
    lastPageId: pageId,
  };
}

function flattenedSource(mediaType: string, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MAX_IMAGE_BYTES) fail("SOURCE_TOO_LARGE", "图片文件超过 20 MiB。");
  const image = `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  const xml = `<mxfile host="专利工作台"><diagram id="page-1" name="第1页"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="" style="shape=image;image=${image};" vertex="1" parent="1"><mxGeometry x="40" y="40" width="480" height="320" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
  return new TextEncoder().encode(xml);
}

function projectName(name: string): string {
  return parsePath(name).name.trim().slice(0, 120) || "导入的流程图";
}

export class FlowchartImportService {
  parse(file: ImportFile): ParsedFlowchartImport {
    const extension = extname(file.name).toLowerCase();
    if (extension === ".drawio" || extension === ".xml") {
      const parsed = validateXml(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
      return { name: projectName(file.name), ...parsed, kind: "editable" };
    }
    if (extension === ".svg") {
      let svg: string;
      try {
        svg = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      } catch {
        fail("MIME_MISMATCH", "SVG 文件不是有效的 UTF-8 文本。");
      }
      if (!/^\s*<svg\b/iu.test(svg)) fail("MIME_MISMATCH", "文件扩展名与实际格式不一致。");
      if (ACTIVE_XML.test(svg)) fail("UNSAFE_XML", "SVG 包含脚本或事件处理器。");
      assertNoRemoteResources(svg);
      const embedded = extractSvgSource(svg);
      if (embedded) {
        const parsed = validateXml(embedded);
        return { name: projectName(file.name), ...parsed, kind: "editable" };
      }
      return {
        name: projectName(file.name),
        source: flattenedSource("image/svg+xml", file.bytes),
        pageCount: 1,
        lastPageId: "page-1",
        kind: "flattened",
      };
    }
    if (extension === ".png") {
      if (!isPng(file.bytes)) fail("MIME_MISMATCH", "文件扩展名与实际 PNG 格式不一致。");
      const embedded = extractPngSource(file.bytes);
      if (embedded) {
        const parsed = validateXml(embedded);
        return { name: projectName(file.name), ...parsed, kind: "editable" };
      }
      return {
        name: projectName(file.name),
        source: flattenedSource("image/png", file.bytes),
        pageCount: 1,
        lastPageId: "page-1",
        kind: "flattened",
      };
    }
    if (extension === ".jpg" || extension === ".jpeg") {
      if (!isJpeg(file.bytes)) fail("MIME_MISMATCH", "文件扩展名与实际 JPEG 格式不一致。");
      return {
        name: projectName(file.name),
        source: flattenedSource("image/jpeg", file.bytes),
        pageCount: 1,
        lastPageId: "page-1",
        kind: "flattened",
      };
    }
    if (extension === ".webp") {
      if (!isWebp(file.bytes)) fail("MIME_MISMATCH", "文件扩展名与实际 WebP 格式不一致。");
      return {
        name: projectName(file.name),
        source: flattenedSource("image/webp", file.bytes),
        pageCount: 1,
        lastPageId: "page-1",
        kind: "flattened",
      };
    }
    fail("UNSUPPORTED_FORMAT", "不支持该流程图文件格式。");
  }
}

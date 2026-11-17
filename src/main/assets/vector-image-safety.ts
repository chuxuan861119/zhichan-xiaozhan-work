import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SAME_DOCUMENT_REFERENCE = /^#[^\s#]+$/u;
const FORBIDDEN_ELEMENT_NAMES = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "foreignobject",
  "iframe",
  "image",
  "script",
  "set",
  "style",
]);
const MAX_SVG_BYTES = 5 * 1024 * 1024;

export type VectorSvgSanitizationResult = {
  svg: string;
  removedUnsafeContent: boolean;
};

function localNameOf(element: { localName: string | null; tagName: string }): string {
  return (element.localName ?? element.tagName).toLocaleLowerCase("en-US");
}

function isUnsafeReference(value: string): boolean {
  return !SAME_DOCUMENT_REFERENCE.test(value.trim());
}

function sanitizeStyle(value: string): string {
  return value
    .replace(/@import\b[^;]*;?/giu, "")
    .replace(/url\s*\(\s*(['"]?)(?!#)[^)]*\1\s*\)/giu, "");
}

function hasUnsafeCssReference(value: string, knownIds: ReadonlyMap<string, string>): boolean {
  if (/@import\b|@font-face\b/iu.test(value)) return true;
  for (const match of value.matchAll(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/giu)) {
    const reference = match[2]?.trim() ?? "";
    if (!SAME_DOCUMENT_REFERENCE.test(reference) || !knownIds.has(reference.slice(1))) return true;
  }
  return false;
}

/**
 * Removes executable/external SVG content and makes generated internal ids
 * deterministic before bytes are hashed or persisted.
 */
export function sanitizeVectorSvgWithReport(markup: string): VectorSvgSanitizationResult {
  if (!markup.trim() || markup.length > MAX_SVG_BYTES) {
    throw new Error("图片 SVG 尺寸无效。");
  }
  if (/<!\s*(?:doctype|entity)\b|<\?[^?]+\?>/iu.test(markup)) {
    throw new Error("图片 SVG 包含不允许的声明。");
  }

  const errors: string[] = [];
  const document = new DOMParser({
    onError: (_level, message) => errors.push(message),
  }).parseFromString(markup, "image/svg+xml");
  const root = document.documentElement;
  if (
    errors.length > 0 ||
    !root ||
    root.namespaceURI !== SVG_NAMESPACE ||
    localNameOf(root) !== "svg"
  ) {
    throw new Error("图片 SVG 无效。");
  }

  const idMap = new Map<string, string>();
  let idIndex = 0;
  let removedUnsafeContent = false;
  const elements = [root, ...Array.from(root.getElementsByTagName("*"))];
  for (const element of elements) {
    const name = localNameOf(element);
    if (FORBIDDEN_ELEMENT_NAMES.has(name)) {
      removedUnsafeContent = true;
      element.parentNode?.removeChild(element);
      continue;
    }
    const id = element.getAttribute("id");
    if (id) {
      idIndex += 1;
      const normalized = `vector-image-id-${idIndex}`;
      idMap.set(id, normalized);
      element.setAttribute("id", normalized);
    }
  }

  const remainingElements = [root, ...Array.from(root.getElementsByTagName("*"))];
  for (const element of remainingElements) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLocaleLowerCase("en-US");
      if (name.startsWith("on") || name === "src") {
        removedUnsafeContent = true;
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        if (isUnsafeReference(attribute.value)) {
          removedUnsafeContent = true;
          element.removeAttribute(attribute.name);
          continue;
        }
        const replacement = idMap.get(attribute.value.slice(1));
        if (!replacement) {
          removedUnsafeContent = true;
          element.removeAttribute(attribute.name);
          continue;
        }
        element.setAttribute(attribute.name, `#${replacement}`);
        continue;
      }
      const sanitized = sanitizeStyle(attribute.value);
      if (hasUnsafeCssReference(attribute.value, idMap)) {
        removedUnsafeContent = true;
      }
      const normalizedReference = sanitized.replace(/#([^\s)'";]+)/gu, (match, referenceId) => {
        const replacement = idMap.get(referenceId);
        return replacement ? `#${replacement}` : match;
      });
      if (normalizedReference !== attribute.value) {
        element.setAttribute(attribute.name, normalizedReference);
      }
    }
  }

  const serialized = new XMLSerializer().serializeToString(document);
  if (
    /<\/?(?:animate|animateMotion|animateTransform|foreignObject|iframe|image|script|set|style)\b|\son\w+\s*=/iu.test(
      serialized,
    ) ||
    /\b(?:href|xlink:href|src)\s*=\s*["'](?!#)/iu.test(serialized)
  ) {
    throw new Error("图片 SVG 未能完成安全清理。");
  }
  const classMap = new Map<string, string>();
  let classIndex = 0;
  const svg = serialized
    .replace(/zr\d+-cls-\d+/gu, (className) => {
      const normalized = classMap.get(className);
      if (normalized) return normalized;
      classIndex += 1;
      const next = `vector-image-class-${classIndex}`;
      classMap.set(className, next);
      return next;
    })
    .replace(/\r\n?/gu, "\n")
    .concat("\n");
  return { svg, removedUnsafeContent };
}

export function sanitizeVectorSvg(markup: string): string {
  return sanitizeVectorSvgWithReport(markup).svg;
}

export function isVectorSvgSafeForExport(markup: string): boolean {
  try {
    return !sanitizeVectorSvgWithReport(markup).removedUnsafeContent;
  } catch {
    return false;
  }
}

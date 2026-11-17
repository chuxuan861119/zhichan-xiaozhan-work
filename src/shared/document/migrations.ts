import type { AppResult } from "../ipc/result.js";
import { docxDocumentFont } from "./font-policy.js";
import {
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type CanonicalDocument,
  CanonicalDocumentV1Schema,
} from "./model.js";
import { validateCanonicalDocument } from "./validation.js";

function invalidVersion(message: string): AppResult<CanonicalDocument> {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

export function addChemicalEditorModes<T>(value: T): T {
  if (Array.isArray(value)) return value.map(addChemicalEditorModes) as T;
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = addChemicalEditorModes(child);
  }
  if (copy.type === "chemical-structure" && !("editorMode" in copy)) {
    copy.editorMode = "molecule";
  }
  return copy as T;
}

const DEFAULT_FONT_FAMILY = "SimSun";

/** Preserve supported stored fonts; rendering resolves them for the current platform. */
export function normalizeFontFamilies<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeFontFamilies) as T;
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = normalizeFontFamilies(child);
  }
  if (
    typeof copy.defaultFontFamily === "string" &&
    docxDocumentFont(copy.defaultFontFamily) === null
  ) {
    copy.defaultFontFamily = DEFAULT_FONT_FAMILY;
  }
  if (
    copy.type === "font-family" &&
    typeof copy.value === "string" &&
    docxDocumentFont(copy.value) === null
  ) {
    copy.value = DEFAULT_FONT_FAMILY;
  }
  return copy as T;
}

function withFontsNormalized<T>(result: AppResult<T>): AppResult<T> {
  return result.ok ? { ok: true, value: normalizeFontFamilies(result.value) } : result;
}

export function migrateCanonicalDocument(input: unknown): AppResult<CanonicalDocument> {
  if (typeof input !== "object" || input === null || !("formatVersion" in input)) {
    return invalidVersion("文档缺少格式版本。");
  }

  const formatVersion = input.formatVersion;
  if (typeof formatVersion === "number" && formatVersion > CANONICAL_DOCUMENT_FORMAT_VERSION) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_VERSION",
        message: "此文件由更新版本的软件创建。当前版本不会覆盖它。",
      },
    };
  }

  if (formatVersion === CANONICAL_DOCUMENT_FORMAT_VERSION) {
    return withFontsNormalized(validateCanonicalDocument(input));
  }

  if (formatVersion === 3) {
    return withFontsNormalized(
      validateCanonicalDocument({
        ...(input as Record<string, unknown>),
        formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
      }),
    );
  }

  if (formatVersion === 2) {
    return withFontsNormalized(
      validateCanonicalDocument(
        addChemicalEditorModes({
          ...(input as Record<string, unknown>),
          formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
        }),
      ),
    );
  }

  if (formatVersion !== 1) {
    return invalidVersion("不支持此文档格式版本。");
  }

  const parsed = CanonicalDocumentV1Schema.safeParse(input);
  if (!parsed.success) return invalidVersion("文档结构无效或包含不支持的内容。");

  return withFontsNormalized(
    validateCanonicalDocument(
      addChemicalEditorModes({
        ...parsed.data,
        formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
      }),
    ),
  );
}

/** @deprecated Use migrateCanonicalDocument. */
export const migrateDocument = migrateCanonicalDocument;

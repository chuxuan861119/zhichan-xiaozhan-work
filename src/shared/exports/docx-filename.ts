export const DOCX_EXTENSION = ".docx";
export const MAX_DOCX_SUGGESTED_NAME_LENGTH = 255 - DOCX_EXTENSION.length;

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function truncateUtf16(value: string, maximumLength: number): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > maximumLength) break;
    result += character;
  }
  return result;
}

export function createDocxSuggestedName(title: string): string {
  const withoutExtension = title.toLocaleLowerCase("en-US").endsWith(DOCX_EXTENSION)
    ? title.slice(0, -DOCX_EXTENSION.length)
    : title;
  const sanitized = [...withoutExtension.replace(/[<>:"/\\|?*]/gu, "_")]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .trim()
    .replace(/[ .]+$/u, "");
  const nonReserved = WINDOWS_RESERVED_NAME.test(sanitized) ? `_${sanitized}` : sanitized;
  const bounded = truncateUtf16(nonReserved, MAX_DOCX_SUGGESTED_NAME_LENGTH).replace(/[ .]+$/u, "");
  return bounded || "未命名专利";
}

export function createDocxDefaultFilename(title: string): string {
  return `${createDocxSuggestedName(title)}${DOCX_EXTENSION}`;
}

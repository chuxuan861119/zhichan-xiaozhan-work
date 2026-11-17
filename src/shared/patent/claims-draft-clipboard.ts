import { PATENT_FIRST_LINE_INDENT_MM } from "./formatting.js";
import { AUTOMATIC_EDIT_RED } from "./reference-marks.js";

/** Only generated text is accepted; arbitrary renderer-supplied HTML never reaches the clipboard. */
export function redDraftClipboardFormats(text: string): { text: string; html: string } {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const paragraphs = escaped
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map(
      (line) =>
        `<p style="white-space:pre-wrap;text-indent:${PATENT_FIRST_LINE_INDENT_MM}mm"><span style="color:${AUTOMATIC_EDIT_RED}">${line || "<br>"}</span></p>`,
    );
  return { text, html: paragraphs.join("") };
}

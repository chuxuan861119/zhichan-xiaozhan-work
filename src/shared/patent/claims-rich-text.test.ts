import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import { ClipboardTextWriteRequestSchema } from "../ipc/contract.js";
import { richDraftClipboardFormats } from "./claims-rich-text.js";

test("preserves typed styles while escaping content and font values", () => {
  const paragraphs = [
    {
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES, defaultFontFamily: 'a";color:red;<' },
      content: [
        {
          type: "text" as const,
          text: '<img src=x onerror="alert(1)">',
          marks: [
            { type: "color" as const, value: "#CC0000" },
            { type: "background-color" as const, value: "#FFFF00" },
            { type: "underline" as const },
            { type: "bold" as const },
            { type: "reference-mark-token" as const, number: 1 },
          ],
        },
      ],
    },
  ];
  const formats = richDraftClipboardFormats(paragraphs);
  expect(formats.html).toContain("color:#CC0000");
  expect(formats.html).toContain("background-color:#FFFF00");
  expect(formats.html).toContain("text-decoration:underline");
  expect(formats.html).toContain("font-weight:700");
  expect(formats.html).not.toContain("<img");
  expect(formats.html).not.toContain("reference-mark");
  expect(formats.text).toBe(paragraphs[0]!.content[0]!.text);
  expect(
    ClipboardTextWriteRequestSchema.safeParse({ style: "formatted-draft", paragraphs }).success,
  ).toBe(true);
  expect(
    ClipboardTextWriteRequestSchema.safeParse({
      style: "formatted-draft",
      paragraphs,
      html: "<script>",
    }).success,
  ).toBe(false);
});

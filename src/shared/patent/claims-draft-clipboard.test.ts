import { ClipboardTextWriteRequestSchema } from "../ipc/contract.js";
import { redDraftClipboardFormats } from "./claims-draft-clipboard.js";

test("creates escaped red HTML and plain text without display decorations, preserving whitespace", () => {
  const text = "箱体1  <部件>&\n\n第二段。";
  const formats = redDraftClipboardFormats(text);
  expect(formats.text).toBe(text);
  expect(formats.html).toContain("color:#D92D20");
  expect(formats.html).toContain("&lt;部件&gt;&amp;");
  expect(formats.html).toContain("white-space:pre-wrap");
  expect(formats.html).toContain("<br>");
  expect(formats.html).not.toMatch(/font-size|background|reference-mark/u);
});
test("indents every draft paragraph by two characters without adding text spaces", () => {
  const text = "第一段。\n第二段。";
  const formats = redDraftClipboardFormats(text);
  expect(formats.html.match(/text-indent:9.88mm/gu)).toHaveLength(2);
  expect(formats.text).toBe(text);
});
test("keeps the existing string contract and only accepts a fixed draft style", () => {
  expect(ClipboardTextWriteRequestSchema.parse("普通复制")).toBe("普通复制");
  expect(
    ClipboardTextWriteRequestSchema.safeParse({ text: "文字", style: "red-draft" }).success,
  ).toBe(true);
  expect(
    ClipboardTextWriteRequestSchema.safeParse({ text: "文字", html: "<script>bad()</script>" })
      .success,
  ).toBe(false);
  expect(ClipboardTextWriteRequestSchema.safeParse({ text: "文字", style: "custom" }).success).toBe(
    false,
  );
});

import { expect, test } from "vitest";
import { ContentFingerprint, createEditorContentFingerprint } from "./content-fingerprint";

test("compares local echoes cheaply and preserves order-independent object equality", () => {
  const a = new ContentFingerprint({
    type: "doc",
    content: [{ type: "text", text: "秘密", attrs: { a: 1, b: 2 } }],
  });
  const b = new ContentFingerprint({
    content: [{ attrs: { b: 2, a: 1 }, text: "秘密", type: "text" }],
    type: "doc",
  });
  expect(a.serialized).not.toBe(b.serialized);
  expect(a.matches(b)).toBe(true);
  expect(a.matches(new ContentFingerprint(JSON.parse(a.serialized)))).toBe(true);
  expect(a.matches(new ContentFingerprint({ type: "doc", content: [] }))).toBe(false);
  expect(new ContentFingerprint([1, 2]).matches(new ContentFingerprint([2, 1]))).toBe(false);
});

test("immutable editor fingerprints serialize only changed blocks with exact equality", () => {
  const fingerprint = createEditorContentFingerprint();
  const firstBlock = { type: "paragraph", content: [{ type: "text", text: '甲"\\\n' }] };
  const secondBlock = { type: "paragraph", content: [{ type: "text", text: "乙" }] };
  const original = { type: "doc", content: [firstBlock, secondBlock] };
  const first = fingerprint(original);
  const serialize = vi.spyOn(JSON, "stringify");
  try {
    const unchanged = fingerprint({ type: "doc", content: [firstBlock, secondBlock] });
    expect(unchanged.sameSerialized(first)).toBe(true);
    expect(serialize).not.toHaveBeenCalled();
    const changedBlock = { type: "paragraph", content: [{ type: "text", text: "丙" }] };
    const changed = fingerprint({ type: "doc", content: [firstBlock, changedBlock] });
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(changed.sameSerialized(first)).toBe(false);
    expect(fingerprint(original).sameSerialized(first)).toBe(true);
    expect(first.serialized).toBe(JSON.stringify(original));
    expect(first.matches(new ContentFingerprint(structuredClone(original)))).toBe(true);
    expect(fingerprint({ type: "doc", content: [] }).serialized).toBe(
      '{"type":"doc","content":[]}',
    );
  } finally {
    serialize.mockRestore();
  }
});

test("ordinary fingerprints snapshot mutable input and retain extra document attributes", () => {
  const content = { type: "doc", attrs: { custom: "value" }, content: [] };
  const fingerprint = createEditorContentFingerprint()(content);
  const expected = JSON.stringify(content);
  content.attrs.custom = "changed";
  expect(fingerprint.serialized).toBe(expected);
  expect(fingerprint.sameSerialized(new ContentFingerprint(content))).toBe(false);
});

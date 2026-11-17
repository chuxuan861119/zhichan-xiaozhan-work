import { renderFormulaDrawingReplacement } from "./formula-drawing-replacement";

test.each(["mathematical", "physics", "chemical-equation"] as const)(
  "%s retains the exact width-specific rendered bytes for confirmation",
  async (kind) => {
    URL.createObjectURL = vi.fn(() => "blob:replacement");
    URL.revokeObjectURL = vi.fn();
    const png = new Uint8Array([1, 2, 3]);
    const render = vi.fn(async () => ({ ok: true, value: { png, widthPx: 1028, heightPx: 100 } }));
    window.patentApi = { formulaDrawings: { render } } as unknown as typeof window.patentApi;
    const preview = await renderFormulaDrawingReplacement("session", { kind, latex: "x^2" }, 87);
    expect(render).toHaveBeenCalledWith({ sessionId: "session", latex: "x^2", outputWidthMm: 87 });
    expect(preview.value.png).toBe(png);
    expect(preview.outputWidthMm).toBe(87);
    preview.dispose?.();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:replacement");
  },
);

test("structure replacement keeps its editable source and uses the newly rendered asset", async () => {
  URL.createObjectURL = vi.fn(() => "blob:replacement");
  const png = new Uint8Array([4, 5, 6]);
  const descriptor = { assetId: "new" };
  const source = { ketSource: "molecule", editorMode: "molecule" as const };
  const rasterizePreview = vi.fn(async () => ({ ok: true, value: { preview: png, descriptor } }));
  window.patentApi = { chemistry: { rasterizePreview } } as unknown as typeof window.patentApi;
  const preview = await renderFormulaDrawingReplacement(
    "session",
    {
      kind: "chemical-structure",
      descriptor: descriptor as never,
      png: new Uint8Array([0]),
      svg: "<svg/>",
      source,
    },
    80,
  );
  expect(rasterizePreview).toHaveBeenCalledWith({
    sessionId: "session",
    svg: "<svg/>",
    source,
    outputWidthMm: 80,
  });
  expect(preview.value.png).toBe(png);
  expect(preview.value.descriptor).toBe(descriptor);
});

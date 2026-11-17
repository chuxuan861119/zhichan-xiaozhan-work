import { detailRasterStrokeScale, imageUrl } from "./render";

test("image URLs preserve a sliced input without an intermediate byte copy", async () => {
  const bytes = new Uint8Array([99, 1, 2, 3, 99]);
  const create = vi.fn((_blob: Blob) => "blob:test");
  vi.stubGlobal("URL", { createObjectURL: create });
  const from = vi.spyOn(Uint8Array, "from");
  try {
    expect(imageUrl(bytes.subarray(1, 4), "image/png")).toBe("blob:test");
    expect(from).not.toHaveBeenCalled();
    const blob = create.mock.calls[0]![0] as Blob;
    expect(blob.size).toBe(3);
    const read = new FileReader();
    const result = new Promise<ArrayBuffer>((resolve) => {
      read.onload = () => resolve(read.result as ArrayBuffer);
    });
    bytes.fill(7);
    read.readAsArrayBuffer(blob);
    expect([...new Uint8Array(await result)]).toEqual([1, 2, 3]);
  } finally {
    from.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("includes nested detail scale when compensating CAD strokes", () => {
  expect(detailRasterStrokeScale({ ratio: 6.6 })).toBeCloseTo(6.6);
  expect(detailRasterStrokeScale({ ratio: 2, sourceScale: 3 })).toBeCloseTo(6);
});

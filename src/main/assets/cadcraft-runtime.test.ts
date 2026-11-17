import { runCadCodec } from "./cadcraft-runtime.js";

test("rejects empty, oversized and pre-cancelled CAD inputs before starting a parser", async () => {
  await expect(runCadCodec("missing", "dxf-to-svg", new Uint8Array())).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    runCadCodec("missing", "dxf-to-svg", new Uint8Array(100 * 1024 * 1024 + 1)),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    runCadCodec("missing", "dxf-to-svg", new Uint8Array([1]), { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});

test("reports an unavailable native codec without exposing drawing contents", async () => {
  await expect(
    runCadCodec("nonexistent-cad-runtime", "dxf-to-svg", new Uint8Array([1])),
  ).rejects.toMatchObject({ code: "CAD_RUNTIME_UNAVAILABLE" });
});

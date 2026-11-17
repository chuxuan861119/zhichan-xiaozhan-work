import { randomUUID } from "node:crypto";
import { DrawingImportRequestSchema, ImportAssetRequestSchema } from "./contract.js";

test("accepts DWG sources through 100 MiB, rejects larger DWGs and keeps other imports at 50 MiB", () => {
  const bytes = new Uint8Array(100 * 1024 * 1024 + 1);
  bytes.set(new TextEncoder().encode("AC1032"));
  const request = {
    sessionId: randomUUID(),
    operationId: randomUUID(),
    originalName: "large.dwg",
    declaredMediaType: null,
    bytes: bytes.subarray(0, 100 * 1024 * 1024),
  };
  expect(DrawingImportRequestSchema.safeParse(request).success).toBe(true);
  expect(DrawingImportRequestSchema.safeParse({ ...request, bytes }).success).toBe(false);
  expect(ImportAssetRequestSchema.safeParse(request).success).toBe(false);
  bytes.fill(0, 0, 8);
  expect(DrawingImportRequestSchema.safeParse(request).success).toBe(false);
});

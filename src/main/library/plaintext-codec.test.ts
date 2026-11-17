import {
  decodeBytes,
  decodeJson,
  encodeBytes,
  encodeJson,
  MAX_PLAINTEXT_BYTES,
  PlaintextCodecError,
} from "./plaintext-codec.js";

test("stores bytes without encryption", () => {
  const plain = Uint8Array.from([0, 1, 2, 254, 255]);
  const stored = encodeBytes(plain);
  expect(stored).toEqual(plain);
  expect(stored).not.toBe(plain);
  expect(decodeBytes(stored)).toEqual(plain);
});

test("stores JSON as ordinary UTF-8", () => {
  const value = { title: "一种夹具", revision: 3 };
  const stored = encodeJson(value);
  expect(Buffer.from(stored).toString("utf8")).toBe(JSON.stringify(value));
  expect(decodeJson<typeof value>(stored)).toEqual(value);
});

test("rejects invalid UTF-8, JSON, and oversized payloads", () => {
  expect(() => decodeJson(Uint8Array.from([0xc3, 0x28]))).toThrow(PlaintextCodecError);
  expect(() => decodeJson(Buffer.from("not-json", "utf8"))).toThrow(PlaintextCodecError);
  expect(() => encodeBytes(new Uint8Array(MAX_PLAINTEXT_BYTES + 1))).toThrow(PlaintextCodecError);
});

test("rejects values JSON cannot serialize", () => {
  expect(() => encodeJson(1n)).toThrow(PlaintextCodecError);
  expect(() => encodeJson(undefined)).toThrow(PlaintextCodecError);
});

import { describe, expect, expectTypeOf, test } from "vitest";
import {
  canonicalEncodeJson,
  createDataTransferFooterMagicBytes,
  createDataTransferMagicBytes,
  DATA_TRANSFER_CHUNK_BYTES,
  DATA_TRANSFER_FOOTER_BYTES,
  DATA_TRANSFER_FOOTER_MAGIC,
  DATA_TRANSFER_FRAME_HEADER_BYTES,
  DATA_TRANSFER_GCM_TAG_BYTES,
  DATA_TRANSFER_HEADER_LIMIT,
  DATA_TRANSFER_MAGIC,
  DATA_TRANSFER_PACKAGE_VERSION,
  DATA_TRANSFER_PASSWORD_CHECK_BLOCK_BYTES,
  DATA_TRANSFER_PASSWORD_CHECK_NONCE_BYTES,
  DATA_TRANSFER_PASSWORD_CHECK_PLAINTEXT_BYTES,
  DataTransferFrameType,
  type DataTransferPublicHeader,
  decodeFrameHeader,
  decodePackageFooter,
  decodePublicHeader,
  decodePublicHeaderLength,
  encodeFrameHeader,
  encodePackageFooter,
  encodePublicHeader,
  encodePublicHeaderMacPayload,
  isTransferLogicalPath,
  type PackageFooter,
  type TransferFrameHeader,
  type TransferLogicalPath,
  TransferLogicalPathSchema,
} from "./package-format.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const packageId = "00000000-0000-4000-8000-000000000001";
const header = {
  packageFormatVersion: 2 as const,
  packageId,
  minimumImporterVersion: "0.1.0",
  kdf: {
    algorithm: "scrypt" as const,
    N: 131_072 as const,
    r: 8 as const,
    p: 1 as const,
    maxmemBytes: 268_435_456 as const,
    derivedKeyBytes: 32 as const,
  },
  saltHex: "a".repeat(64),
  noncePrefixHex: "b".repeat(8),
  passwordCheckHex: "c".repeat(98),
  passwordHint: "仅供本人识别",
  headerMacHex: "d".repeat(64),
};

function replaceHeaderJson(transform: (json: string) => string): Uint8Array {
  return encoder.encode(transform(decoder.decode(encodePublicHeader(header))));
}

describe("canonical JSON", () => {
  test("recursively sorts object keys while preserving array order", () => {
    const first = canonicalEncodeJson({
      z: 1,
      nested: { beta: 2, alpha: 1 },
      list: [{ b: 2, a: 1 }, 3],
    });
    const second = canonicalEncodeJson({
      list: [{ a: 1, b: 2 }, 3],
      nested: { alpha: 1, beta: 2 },
      z: 1,
    });

    expect(first).toEqual(second);
    expect(decoder.decode(first)).toBe(
      '{"list":[{"a":1,"b":2},3],"nested":{"alpha":1,"beta":2},"z":1}',
    );
  });

  test.each([
    undefined,
    () => undefined,
    Symbol("invalid"),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    { value: undefined },
    [undefined],
  ])("rejects non-JSON value %s", (value) => {
    expect(() => canonicalEncodeJson(value)).toThrow("Invalid canonical JSON value");
  });

  test("rejects cyclic values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalEncodeJson(cyclic)).toThrow("Invalid canonical JSON value");
  });

  test("rejects sparse arrays and symbol-keyed properties instead of silently dropping them", () => {
    const sparse = new Array(1);
    const symbolKeyed = { visible: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("hidden")] = "not JSON";

    expect(() => canonicalEncodeJson(sparse)).toThrow("Invalid canonical JSON value");
    expect(() => canonicalEncodeJson(symbolKeyed)).toThrow("Invalid canonical JSON value");
  });

  test.each([
    {
      kind: "symbol",
      value: (() => {
        const value = ["visible"] as unknown[] & Record<PropertyKey, unknown>;
        value[Symbol("hidden")] = "not JSON";
        return value;
      })(),
    },
    { kind: "extra string", value: Object.assign(["visible"], { extra: "not JSON" }) },
  ])("rejects $kind own properties on arrays", ({ value }) => {
    expect(() => canonicalEncodeJson(value)).toThrow("Invalid canonical JSON value");
  });

  test("reads array elements by index without calling an overridden map method", () => {
    class OverriddenMapArray extends Array<unknown> {
      override map<U>(
        _callbackfn: (value: unknown, index: number, array: unknown[]) => U,
        _thisArg?: unknown,
      ): U[] {
        throw new Error("custom map must not run");
      }
    }
    const value = new OverriddenMapArray("real");

    expect(decoder.decode(canonicalEncodeJson(value))).toBe('["real"]');
  });

  test("rejects an array index accessor without invoking its getter", () => {
    let getterCalls = 0;
    const value = ["initial"];
    Object.defineProperty(value, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "not data";
      },
    });

    let error: unknown;
    try {
      canonicalEncodeJson(value);
    } catch (caught) {
      error = caught;
    }
    expect.soft(error).toEqual(new Error("Invalid canonical JSON value"));
    expect(getterCalls).toBe(0);
  });

  test("rejects own non-enumerable string properties on plain objects", () => {
    const value = { visible: true };
    Object.defineProperty(value, "hidden", { value: "not JSON", enumerable: false });

    expect(() => canonicalEncodeJson(value)).toThrow("Invalid canonical JSON value");
  });

  test("rejects accessors without invoking their getter", () => {
    let getterCalls = 0;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "not data";
      },
    });

    expect(() => canonicalEncodeJson(value)).toThrow("Invalid canonical JSON value");
    expect(getterCalls).toBe(0);
  });

  test("accepts normal data properties on plain and null-prototype objects", () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.beta = 2;
    nullPrototype.alpha = 1;

    expect(decoder.decode(canonicalEncodeJson({ beta: 2, alpha: 1 }))).toBe('{"alpha":1,"beta":2}');
    expect(decoder.decode(canonicalEncodeJson(nullPrototype))).toBe('{"alpha":1,"beta":2}');
  });
});

describe("public package header", () => {
  test("exports the fixed v1 constants", () => {
    expect(DATA_TRANSFER_PACKAGE_VERSION).toBe(2);
    expect(DATA_TRANSFER_MAGIC).toEqual(
      Uint8Array.from([
        0x5a, 0x58, 0x57, 0x42, 0x41, 0x43, 0x4b, 0x55, 0x50, 0x00, 0x01, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
    );
    expect(DATA_TRANSFER_HEADER_LIMIT).toBe(64 * 1024);
    expect(DATA_TRANSFER_CHUNK_BYTES).toBe(8 * 1024 * 1024);
  });

  test("exports the fixed encrypted password-verifier layout", () => {
    expect(DATA_TRANSFER_PASSWORD_CHECK_NONCE_BYTES).toBe(12);
    expect(DATA_TRANSFER_GCM_TAG_BYTES).toBe(16);
    expect(DATA_TRANSFER_PASSWORD_CHECK_PLAINTEXT_BYTES).toBe(21);
    expect(DATA_TRANSFER_PASSWORD_CHECK_BLOCK_BYTES).toBe(49);
  });

  test("exports typed magic bytes and isolates fresh factories from compatibility mutations", () => {
    expect(DATA_TRANSFER_MAGIC).toBeInstanceOf(Uint8Array);
    expect(DATA_TRANSFER_FOOTER_MAGIC).toBeInstanceOf(Uint8Array);
    expect(DATA_TRANSFER_MAGIC.byteLength).toBe(15);
    expect(DATA_TRANSFER_FOOTER_MAGIC.byteLength).toBe(8);
    expect(DATA_TRANSFER_MAGIC.subarray(0, 3)).toEqual(Uint8Array.from([0x5a, 0x58, 0x57]));
    expect(DATA_TRANSFER_FOOTER_MAGIC.subarray(0, 3)).toEqual(Uint8Array.from([0x5a, 0x58, 0x57]));
    expect(typeof createDataTransferMagicBytes).toBe("function");
    expect(typeof createDataTransferFooterMagicBytes).toBe("function");

    const packageFirstByte = DATA_TRANSFER_MAGIC[0];
    const footerFirstByte = DATA_TRANSFER_FOOTER_MAGIC[0];
    try {
      DATA_TRANSFER_MAGIC[0] = 0;
      DATA_TRANSFER_FOOTER_MAGIC[0] = 0;
      expect(createDataTransferMagicBytes()[0]).toBe(0x5a);
      expect(createDataTransferFooterMagicBytes()[0]).toBe(0x5a);
    } finally {
      DATA_TRANSFER_MAGIC[0] = packageFirstByte ?? 0x5a;
      DATA_TRANSFER_FOOTER_MAGIC[0] = footerFirstByte ?? 0x5a;
    }
  });

  test("deterministically round-trips a strict readonly header within the limit", () => {
    const reordered = {
      headerMacHex: header.headerMacHex,
      passwordHint: header.passwordHint,
      passwordCheckHex: header.passwordCheckHex,
      noncePrefixHex: header.noncePrefixHex,
      saltHex: header.saltHex,
      kdf: {
        p: 1,
        r: 8,
        N: 131_072,
        derivedKeyBytes: 32,
        maxmemBytes: 256 * 1024 * 1024,
        algorithm: "scrypt",
      },
      minimumImporterVersion: header.minimumImporterVersion,
      packageId: header.packageId,
      packageFormatVersion: 2,
    } as const;
    const bytes = encodePublicHeader(header);

    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(DATA_TRANSFER_HEADER_LIMIT);
    expect(encodePublicHeader(reordered)).toEqual(bytes);
    expect(decodePublicHeader(bytes)).toEqual(header);
    expect(Object.isFrozen(decodePublicHeader(bytes))).toBe(true);
    expect(Object.isFrozen(decodePublicHeader(bytes).kdf)).toBe(true);
    expectTypeOf<DataTransferPublicHeader>().toEqualTypeOf<Readonly<DataTransferPublicHeader>>();
  });

  test("does not admit patent metadata, paths, secrets, or unknown fields", () => {
    for (const extra of [
      { patentTitle: "绝密专利" },
      { sourcePath: "D:\\客户\\绝密.patdoc" },
      { password: "secret" },
      { privateExtra: "private" },
    ]) {
      expect(() => encodePublicHeader({ ...header, ...extra })).toThrow();
    }
    const text = decoder.decode(encodePublicHeader(header));
    expect(text).not.toContain("专利");
    expect(text).not.toContain("\\客户");
  });

  test("rejects unknown versions, extra keys, and invalid field boundaries", () => {
    expect(() =>
      encodePublicHeader({
        ...header,
        packageFormatVersion: 3,
      } as unknown as DataTransferPublicHeader),
    ).toThrow();
    expect(() => encodePublicHeader({ ...header, minimumImporterVersion: "" })).toThrow();
    expect(() =>
      encodePublicHeader({ ...header, minimumImporterVersion: "v".repeat(65) }),
    ).toThrow();
    expect(() => encodePublicHeader({ ...header, saltHex: "A".repeat(64) })).toThrow();
    expect(() => encodePublicHeader({ ...header, noncePrefixHex: "a".repeat(7) })).toThrow();
    expect(() => encodePublicHeader({ ...header, passwordCheckHex: "a".repeat(63) })).toThrow();
    expect(() => encodePublicHeader({ ...header, headerMacHex: "a".repeat(65) })).toThrow();
    expect(() =>
      encodePublicHeader({
        ...header,
        kdf: { ...header.kdf, r: 9 },
      } as unknown as DataTransferPublicHeader),
    ).toThrow();
    expect(() =>
      decodePublicHeader(
        replaceHeaderJson((json) =>
          json.replace('"packageFormatVersion":2', '"packageFormatVersion":3'),
        ),
      ),
    ).toThrow();
    expect(() =>
      decodePublicHeader(replaceHeaderJson((json) => json.replace(/}$/, ',"extra":true}'))),
    ).toThrow();
  });

  test("accepts exactly one 49-byte lowercase encrypted password verifier", () => {
    expect
      .soft(() => encodePublicHeader({ ...header, passwordCheckHex: "a".repeat(98) }))
      .not.toThrow();
    for (const passwordCheckHex of [
      "a".repeat(64),
      "a".repeat(96),
      "a".repeat(100),
      "A".repeat(98),
      "g".repeat(98),
    ]) {
      expect.soft(() => encodePublicHeader({ ...header, passwordCheckHex })).toThrow();
    }
  });

  test.each([
    "0.1.0",
    "1.2.3-alpha.1+build.5",
    "1.0.0-0.3.7",
    "1.0.0-x.7.z.92",
    "1.2.3+001",
    `1.0.0+${"a".repeat(58)}`,
  ])("accepts SemVer 2.0.0 minimum importer version %s", (minimumImporterVersion) => {
    expect(() => encodePublicHeader({ ...header, minimumImporterVersion })).not.toThrow();
  });

  test.each([
    "v1.2.3",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    " 1.2.3",
    "1.2.3 ",
    "1.2.3\n",
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3-alpha_1",
    "1.2.3+",
    "latest",
    `1.0.0+${"a".repeat(59)}`,
  ])("rejects invalid minimum importer version %j", (minimumImporterVersion) => {
    expect(() => encodePublicHeader({ ...header, minimumImporterVersion })).toThrow();
  });

  test("matches an independent canonical UTF-8 public-header golden vector", () => {
    const referenceHeader: DataTransferPublicHeader = {
      packageFormatVersion: 2,
      packageId: "123e4567-e89b-42d3-a456-426614174000",
      minimumImporterVersion: "1.2.3-beta.1+build.5",
      kdf: {
        algorithm: "scrypt",
        N: 131_072,
        r: 8,
        p: 1,
        maxmemBytes: 268_435_456,
        derivedKeyBytes: 32,
      },
      saltHex: "0123456789abcdef".repeat(4),
      noncePrefixHex: "89abcdef",
      passwordCheckHex: `${"fedcba9876543210".repeat(6)}fe`,
      passwordHint: '提示"甲"',
      headerMacHex: "0011223344556677".repeat(4),
    };
    const expectedText =
      '{"headerMacHex":"0011223344556677001122334455667700112233445566770011223344556677","kdf":{"N":131072,"algorithm":"scrypt","derivedKeyBytes":32,"maxmemBytes":268435456,"p":1,"r":8},"minimumImporterVersion":"1.2.3-beta.1+build.5","noncePrefixHex":"89abcdef","packageFormatVersion":2,"packageId":"123e4567-e89b-42d3-a456-426614174000","passwordCheckHex":"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fe","passwordHint":"提示\\"甲\\"","saltHex":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}';
    const expectedBytes = encoder.encode(expectedText);

    expect(encodePublicHeader(referenceHeader)).toEqual(expectedBytes);
    expect(decoder.decode(expectedBytes)).toBe(expectedText);
    expect(expectedBytes).toContain(0xe6);
  });

  test("matches an independent canonical UTF-8 header-MAC golden vector", () => {
    const referenceHeader: DataTransferPublicHeader = {
      packageFormatVersion: 2,
      packageId: "123e4567-e89b-42d3-a456-426614174000",
      minimumImporterVersion: "1.2.3-beta.1+build.5",
      kdf: {
        algorithm: "scrypt",
        N: 131_072,
        r: 8,
        p: 1,
        maxmemBytes: 268_435_456,
        derivedKeyBytes: 32,
      },
      saltHex: "0123456789abcdef".repeat(4),
      noncePrefixHex: "89abcdef",
      passwordCheckHex: `${"fedcba9876543210".repeat(6)}fe`,
      passwordHint: '提示"甲"',
      headerMacHex: "0011223344556677".repeat(4),
    };
    const expectedText =
      '{"kdf":{"N":131072,"algorithm":"scrypt","derivedKeyBytes":32,"maxmemBytes":268435456,"p":1,"r":8},"minimumImporterVersion":"1.2.3-beta.1+build.5","noncePrefixHex":"89abcdef","packageFormatVersion":2,"packageId":"123e4567-e89b-42d3-a456-426614174000","passwordCheckHex":"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fe","passwordHint":"提示\\"甲\\"","saltHex":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}';
    const expectedBytes = encoder.encode(expectedText);

    expect(encodePublicHeaderMacPayload(referenceHeader)).toEqual(expectedBytes);
    expect(decoder.decode(expectedBytes)).toBe(expectedText);
    expect(expectedBytes).toContain(0xe6);
  });

  test.each(["a".repeat(200), "", null])("accepts password hint boundary %j", (passwordHint) => {
    expect(decodePublicHeader(encodePublicHeader({ ...header, passwordHint })).passwordHint).toBe(
      passwordHint,
    );
  });

  test.each([
    "a".repeat(201),
    "line\nbreak",
    "carriage\rreturn",
    "nul\0byte",
    "D:/private",
    "D:\\private",
    "\u0001",
  ])("rejects unsafe password hint %j", (passwordHint) => {
    expect(() => encodePublicHeader({ ...header, passwordHint })).toThrow();
  });

  test("rejects non-canonical JSON, duplicate keys, trailing data, and invalid UTF-8", () => {
    const canonical = decoder.decode(encodePublicHeader(header));
    expect(() => decodePublicHeader(encoder.encode(JSON.stringify(header)))).toThrow(
      "Invalid canonical package header",
    );
    expect(() => decodePublicHeader(encoder.encode(` ${canonical}`))).toThrow(
      "Invalid canonical package header",
    );
    expect(() =>
      decodePublicHeader(
        encoder.encode(
          canonical.replace("{", '{"packageId":"00000000-0000-4000-8000-000000000001",'),
        ),
      ),
    ).toThrow("Invalid canonical package header");
    expect(() => decodePublicHeader(encoder.encode(`${canonical}null`))).toThrow();
    expect(() => decodePublicHeader(Uint8Array.from([0xc3, 0x28]))).toThrow(
      "Invalid package header UTF-8",
    );
  });

  test("validates encoded header lengths with a stable error", () => {
    for (const length of [1, DATA_TRANSFER_HEADER_LIMIT])
      expect(decodePublicHeaderLength(length)).toBe(length);
    for (const length of [0, -1, 1.5, DATA_TRANSFER_HEADER_LIMIT + 1, Number.NaN]) {
      expect(() => decodePublicHeaderLength(length)).toThrow("Invalid package header length");
    }
    expect(() => decodePublicHeader(new Uint8Array())).toThrow("Invalid package header length");
    expect(() => decodePublicHeader(new Uint8Array(DATA_TRANSFER_HEADER_LIMIT + 1))).toThrow(
      "Invalid package header length",
    );
  });

  test("encodes an unambiguous deterministic MAC payload without headerMacHex", () => {
    const withMac = encodePublicHeaderMacPayload(header);
    const withoutMac = encodePublicHeaderMacPayload({
      packageFormatVersion: header.packageFormatVersion,
      packageId: header.packageId,
      minimumImporterVersion: header.minimumImporterVersion,
      kdf: header.kdf,
      saltHex: header.saltHex,
      noncePrefixHex: header.noncePrefixHex,
      passwordCheckHex: header.passwordCheckHex,
      passwordHint: header.passwordHint,
    });
    expect(withMac).toEqual(withoutMac);
    expect(decoder.decode(withMac)).not.toContain("headerMacHex");
    expect(decoder.decode(withMac)).toContain('"passwordHint"');
  });
});

describe("transfer logical paths", () => {
  const draftId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const allowed = [
    "library/library.sqlite3",
    `library/assets/${"A".repeat(64)}.asset`,
    `legacy-drafts/${draftId}/draft.json`,
    `legacy-drafts/${draftId}/20260816-235959.patdoc`,
    "portable-settings.json",
    "verification/integrity-summary.json",
  ] as const;

  test.each(allowed)("accepts whitelisted logical path %s", (path) => {
    expect(TransferLogicalPathSchema.parse(path)).toBe(path);
    expect(isTransferLogicalPath(path)).toBe(true);
  });

  test.each([
    "\\library\\library.sqlite3",
    "/library/library.sqlite3",
    "library/../library.sqlite3",
    "library//library.sqlite3",
    "library/library.sqlite3?download=1",
    "portable-settings.json#fragment",
    `library/assets/${"a".repeat(64)}.asset`,
    `library/assets/${"A".repeat(63)}.asset`,
    `legacy-drafts/${draftId.toUpperCase()}/draft.json`,
    "legacy-drafts/not-a-uuid/draft.json",
    `legacy-drafts/${draftId}/20260816-23595.patdoc`,
    `legacy-drafts/${draftId}/20260816-235959.patdoc.bak`,
    "library/library.sqlite3.bak",
    "unknown/file.bin",
  ])("rejects non-whitelisted logical path %s", (path) => {
    expect(TransferLogicalPathSchema.safeParse(path).success).toBe(false);
    expect(isTransferLogicalPath(path)).toBe(false);
  });

  test("infers a branded logical-path type", () => {
    expectTypeOf<TransferLogicalPath>().not.toEqualTypeOf<string>();
  });
});

describe("frame header", () => {
  const frame: TransferFrameHeader = {
    type: DataTransferFrameType.EntryData,
    flags: 1,
    globalSequence: 0x0102030405060708n,
    entryOrdinal: 0x11121314,
    chunkIndex: 0x21222324,
    plainLength: 0x00323334,
    cipherLength: 0x00424344,
  };

  test("uses the exact 28-byte big-endian layout", () => {
    expect(DATA_TRANSFER_FRAME_HEADER_BYTES).toBe(28);
    const bytes = encodeFrameHeader(frame);
    expect(bytes).toEqual(
      Uint8Array.from([
        2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0x11, 0x12, 0x13, 0x14, 0x21, 0x22, 0x23, 0x24, 0x00,
        0x32, 0x33, 0x34, 0x00, 0x42, 0x43, 0x44,
      ]),
    );
  });

  test("round-trips valid manifest and entry frames", () => {
    const manifest: TransferFrameHeader = {
      type: DataTransferFrameType.Manifest,
      flags: 1,
      globalSequence: 0n,
      entryOrdinal: 0,
      chunkIndex: 0,
      plainLength: 0,
      cipherLength: 16,
    };
    const entry: TransferFrameHeader = {
      type: DataTransferFrameType.EntryData,
      flags: 0,
      globalSequence: 1n,
      entryOrdinal: 1,
      chunkIndex: 0,
      plainLength: DATA_TRANSFER_CHUNK_BYTES,
      cipherLength: DATA_TRANSFER_CHUNK_BYTES + 16,
    };
    expect(decodeFrameHeader(encodeFrameHeader(manifest))).toEqual(manifest);
    expect(decodeFrameHeader(encodeFrameHeader(entry))).toEqual(entry);
  });

  test("preserves u64 and u32 boundaries without converting u64 to number", () => {
    const boundary: TransferFrameHeader = {
      type: DataTransferFrameType.EntryData,
      flags: 1,
      globalSequence: 0xffffffffffffffffn,
      entryOrdinal: 0xffffffff,
      chunkIndex: 0xffffffff,
      plainLength: 1,
      cipherLength: 16,
    };
    const decoded = decodeFrameHeader(encodeFrameHeader(boundary));
    expect(decoded).toEqual(boundary);
    expect(typeof decoded.globalSequence).toBe("bigint");
    for (const invalid of [-1n, 0x10000000000000000n]) {
      expect(() => encodeFrameHeader({ ...boundary, globalSequence: invalid })).toThrow();
    }
    for (const invalid of [-1, 0x100000000, 1.5]) {
      expect(() => encodeFrameHeader({ ...boundary, entryOrdinal: invalid })).toThrow();
    }
  });

  test("rejects reserved bits, unknown types and flags, and invalid manifest flags", () => {
    const bytes = encodeFrameHeader(frame);
    for (const [offset, value] of [
      [0, 3],
      [1, 2],
      [2, 1],
    ] as const) {
      const changed = bytes.slice();
      changed[offset] = value;
      expect(() => decodeFrameHeader(changed)).toThrow();
    }
    expect(() => encodeFrameHeader({ ...frame, type: 3 as DataTransferFrameType })).toThrow();
    expect(() => encodeFrameHeader({ ...frame, flags: 2 })).toThrow();
    expect(() =>
      encodeFrameHeader({ ...frame, type: DataTransferFrameType.Manifest, flags: 0 }),
    ).toThrow();
  });

  test("rejects invalid length boundaries and non-final empty chunks", () => {
    expect(() =>
      encodeFrameHeader({ ...frame, plainLength: DATA_TRANSFER_CHUNK_BYTES + 1 }),
    ).toThrow();
    expect(() =>
      encodeFrameHeader({ ...frame, cipherLength: DATA_TRANSFER_CHUNK_BYTES + 17 }),
    ).toThrow();
    expect(() => encodeFrameHeader({ ...frame, cipherLength: 15 })).toThrow();
    expect(() => encodeFrameHeader({ ...frame, flags: 0, plainLength: 0 })).toThrow();
    expect(() =>
      encodeFrameHeader({ ...frame, flags: 1, plainLength: 0, cipherLength: 16 }),
    ).not.toThrow();
  });

  test("requires exactly 28 bytes", () => {
    const bytes = encodeFrameHeader(frame);
    expect(() => decodeFrameHeader(bytes.subarray(0, 27))).toThrow("Invalid frame header length");
    expect(() => decodeFrameHeader(Uint8Array.from([...bytes, 0]))).toThrow(
      "Invalid frame header length",
    );
  });
});

describe("package footer", () => {
  const footer: PackageFooter = {
    manifestFrameOffset: 0x0102030405060708n,
    totalFrames: 0x1112131415161718n,
    finalAuthenticationChainDigest: Uint8Array.from({ length: 32 }, (_, index) => index),
    footerMac: Uint8Array.from({ length: 32 }, (_, index) => 0x80 + index),
  };

  test("uses the fixed magic and exact 88-byte big-endian layout", () => {
    expect(DATA_TRANSFER_FOOTER_BYTES).toBe(88);
    expect(DATA_TRANSFER_FOOTER_MAGIC).toEqual(
      Uint8Array.from([0x5a, 0x58, 0x57, 0x45, 0x4e, 0x44, 0x31, 0x00]),
    );
    const bytes = encodePackageFooter(footer);
    expect(bytes.subarray(0, 8)).toEqual(DATA_TRANSFER_FOOTER_MAGIC);
    expect(bytes.subarray(8, 16)).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(bytes.subarray(16, 24)).toEqual(
      Uint8Array.from([0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18]),
    );
    expect(bytes.subarray(24, 56)).toEqual(footer.finalAuthenticationChainDigest);
    expect(bytes.subarray(56, 88)).toEqual(footer.footerMac);
  });

  test("uses private standard footer magic even after attempted exported-magic mutation", () => {
    const originalFirstByte = DATA_TRANSFER_FOOTER_MAGIC[0] ?? 0x5a;
    try {
      DATA_TRANSFER_FOOTER_MAGIC[0] = 0;

      const bytes = encodePackageFooter(footer);
      expect(Array.from(bytes.subarray(0, 8))).toEqual([
        0x5a, 0x58, 0x57, 0x45, 0x4e, 0x44, 0x31, 0x00,
      ]);
      expect(() => decodePackageFooter(bytes)).not.toThrow();
      const forged = bytes.slice();
      forged[0] = 0;
      expect(() => decodePackageFooter(forged)).toThrow("Invalid package footer magic");
    } finally {
      DATA_TRANSFER_FOOTER_MAGIC[0] = originalFirstByte;
    }
  });

  test("round-trips u64 boundaries and returns independent byte copies", () => {
    const boundary: PackageFooter = {
      ...footer,
      manifestFrameOffset: 0n,
      totalFrames: 0xffffffffffffffffn,
    };
    const bytes = encodePackageFooter(boundary);
    const decoded = decodePackageFooter(bytes);
    expect(decoded).toEqual(boundary);
    expect(typeof decoded.totalFrames).toBe("bigint");
    expect(decoded.finalAuthenticationChainDigest.buffer).not.toBe(bytes.buffer);
    expect(decoded.footerMac.buffer).not.toBe(bytes.buffer);
    bytes.fill(0);
    expect(decoded.finalAuthenticationChainDigest).toEqual(boundary.finalAuthenticationChainDigest);
    expect(decoded.footerMac).toEqual(boundary.footerMac);
  });

  test("copies footer byte fields even when a Uint8Array subclass overrides slice", () => {
    class SharingSliceUint8Array extends Uint8Array {
      override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
        return this.subarray(start, end);
      }
    }
    const bytes = new SharingSliceUint8Array(encodePackageFooter(footer));

    const decoded = decodePackageFooter(bytes);
    expect(decoded.finalAuthenticationChainDigest.constructor).toBe(Uint8Array);
    expect(decoded.footerMac.constructor).toBe(Uint8Array);
    expect(decoded.finalAuthenticationChainDigest.buffer).not.toBe(bytes.buffer);
    expect(decoded.footerMac.buffer).not.toBe(bytes.buffer);

    const digestBefore = decoded.finalAuthenticationChainDigest[0];
    const macBefore = decoded.footerMac[0];
    bytes[24] = 0xff;
    bytes[56] = 0xff;
    expect(decoded.finalAuthenticationChainDigest[0]).toBe(digestBefore);
    expect(decoded.footerMac[0]).toBe(macBefore);
  });

  test("rejects invalid u64 and digest boundaries", () => {
    for (const invalid of [-1n, 0x10000000000000000n]) {
      expect(() => encodePackageFooter({ ...footer, manifestFrameOffset: invalid })).toThrow();
      expect(() => encodePackageFooter({ ...footer, totalFrames: invalid })).toThrow();
    }
    expect(() =>
      encodePackageFooter({ ...footer, finalAuthenticationChainDigest: new Uint8Array(31) }),
    ).toThrow();
    expect(() => encodePackageFooter({ ...footer, footerMac: new Uint8Array(33) })).toThrow();
  });

  test("rejects invalid magic, truncation, and trailing bytes", () => {
    const bytes = encodePackageFooter(footer);
    const invalidMagic = bytes.slice();
    invalidMagic[0] = 0xff;
    expect(() => decodePackageFooter(invalidMagic)).toThrow("Invalid package footer magic");
    expect(() => decodePackageFooter(bytes.subarray(0, 87))).toThrow(
      "Invalid package footer length",
    );
    expect(() => decodePackageFooter(Uint8Array.from([...bytes, 0]))).toThrow(
      "Invalid package footer length",
    );
  });
});

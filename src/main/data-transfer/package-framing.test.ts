import { Buffer } from "node:buffer";
import crypto, { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  DATA_TRANSFER_CHUNK_BYTES,
  DATA_TRANSFER_FRAME_HEADER_BYTES,
  DATA_TRANSFER_GCM_TAG_BYTES,
  DataTransferFrameType,
  decodeFrameHeader,
} from "../../shared/data-transfer/package-format.js";
import {
  AuthenticatedFrameReader,
  AuthenticatedFrameWriter,
  computePublicHeaderDigest,
  createFrameNonce,
  createFrameNoncePrefix,
  createInitialAuthenticationChainDigest,
  DataTransferFramingError,
  type EncodedAuthenticatedFrame,
} from "./package-framing.js";

const PAYLOAD_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const PACKAGE_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_PACKAGE_ID = "123e4567-e89b-42d3-a456-426614174001";
const NONCE_PREFIX = Buffer.from("01020304", "hex");
const PUBLIC_HEADER_BYTES = Buffer.from('{"packageFormatVersion":1}', "utf8");
const PUBLIC_HEADER_DIGEST = computePublicHeaderDigest(PUBLIC_HEADER_BYTES);
const FIXED_VECTOR_HEADER_DIGEST = Buffer.from(
  "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
  "hex",
);

type ReferencePackage = Readonly<{
  bytes: Buffer;
  frames: readonly EncodedAuthenticatedFrame[];
  totalFrames: bigint;
  finalAuthenticationChainDigest: Buffer;
}>;

function context(
  overrides: Partial<ConstructorParameters<typeof AuthenticatedFrameWriter>[0]> = {},
) {
  return {
    payloadKey: PAYLOAD_KEY,
    packageId: PACKAGE_ID,
    publicHeaderDigest: PUBLIC_HEADER_DIGEST,
    noncePrefix: NONCE_PREFIX,
    ...overrides,
  };
}

type ReadAllFramesOptions = ConstructorParameters<typeof AuthenticatedFrameReader>[0] &
  Readonly<{
    expectedTotalFrames: bigint;
    expectedFinalAuthenticationChainDigest: Buffer;
  }>;

function readAuthenticatedFrames(bytes: Buffer, options: ReadAllFramesOptions) {
  const reader = new AuthenticatedFrameReader(options);
  const frames: Array<ReturnType<AuthenticatedFrameReader["decrypt"]>> = [];
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      if (reader.totalFrames === options.expectedTotalFrames) {
        throw new DataTransferFramingError("PACKAGE_TAMPERED");
      }
      if (bytes.byteLength - offset < DATA_TRANSFER_FRAME_HEADER_BYTES) {
        throw new DataTransferFramingError("PACKAGE_INCOMPLETE");
      }
      const headerBytes = bytes.subarray(offset, offset + DATA_TRANSFER_FRAME_HEADER_BYTES);
      let payloadLength: number;
      try {
        payloadLength = decodeFrameHeader(headerBytes).cipherLength;
      } catch {
        throw new DataTransferFramingError("PACKAGE_TAMPERED");
      }
      const payloadOffset = offset + DATA_TRANSFER_FRAME_HEADER_BYTES;
      const frameEnd = payloadOffset + payloadLength;
      if (frameEnd > bytes.byteLength) {
        throw new DataTransferFramingError("PACKAGE_INCOMPLETE");
      }
      frames.push(reader.decrypt(headerBytes, bytes.subarray(payloadOffset, frameEnd)));
      offset = frameEnd;
    }
    reader.finish(options.expectedTotalFrames, options.expectedFinalAuthenticationChainDigest);
    return frames;
  } catch (error) {
    for (const frame of frames) frame.compressedBytes.fill(0);
    throw error;
  }
}

function serializeFrame(frame: EncodedAuthenticatedFrame): Buffer {
  return Buffer.concat([frame.headerBytes, frame.ciphertext, frame.authenticationTag]);
}

function payload(frame: EncodedAuthenticatedFrame): Buffer {
  return Buffer.concat([frame.ciphertext, frame.authenticationTag]);
}

function encodeReferenceFrames(firstPayload = "alpha"): ReferencePackage {
  const writer = new AuthenticatedFrameWriter(context());
  const frames = [
    writer.encrypt({
      type: DataTransferFrameType.EntryData,
      flags: 0,
      entryOrdinal: 4,
      chunkIndex: 0,
      plainLength: 11,
      compressedBytes: Buffer.from(firstPayload, "utf8"),
    }),
    writer.encrypt({
      type: DataTransferFrameType.EntryData,
      flags: 1,
      entryOrdinal: 4,
      chunkIndex: 1,
      plainLength: 10,
      compressedBytes: Buffer.from("bravo", "utf8"),
    }),
    writer.encrypt({
      type: DataTransferFrameType.Manifest,
      flags: 1,
      entryOrdinal: 0,
      chunkIndex: 0,
      plainLength: 7,
      compressedBytes: Buffer.from("charlie", "utf8"),
    }),
  ];
  return {
    bytes: Buffer.concat(frames.map(serializeFrame)),
    frames,
    totalFrames: writer.totalFrames,
    finalAuthenticationChainDigest: writer.finalAuthenticationChainDigest,
  };
}

function splitSerializedFrames(bytes: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < DATA_TRANSFER_FRAME_HEADER_BYTES) {
      throw new Error("reference package unexpectedly truncated");
    }
    const payloadLength = bytes.readUInt32BE(offset + 24);
    const end = offset + DATA_TRANSFER_FRAME_HEADER_BYTES + payloadLength;
    if (end > bytes.byteLength) throw new Error("reference frame unexpectedly truncated");
    frames.push(Buffer.from(bytes.subarray(offset, end)));
    offset = end;
  }
  return frames;
}

function splitReferenceFrames(bytes: Buffer): readonly [Buffer, Buffer, Buffer] {
  const [first, second, third, extra] = splitSerializedFrames(bytes);
  if (!first || !second || !third || extra) {
    throw new Error("reference package must contain exactly three frames");
  }
  return [first, second, third];
}

function byteAt(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) throw new Error("reference byte offset is out of bounds");
  return value;
}

type Mutation = "delete" | "insert" | "duplicate" | "swap" | "truncate" | "tamper";

function mutateFrames(bytes: Buffer, mutation: Mutation): Buffer {
  const [first, second, third] = splitReferenceFrames(bytes);
  switch (mutation) {
    case "delete":
      return Buffer.concat([first, third]);
    case "insert": {
      const insertionOffset = first.byteLength;
      return Buffer.concat([
        bytes.subarray(0, insertionOffset),
        Buffer.from([0xff]),
        bytes.subarray(insertionOffset),
      ]);
    }
    case "duplicate":
      return Buffer.concat([first, second, second, third]);
    case "swap":
      return Buffer.concat([second, first, third]);
    case "truncate":
      return Buffer.from(bytes.subarray(0, -1));
    case "tamper": {
      const mutated = Buffer.from(bytes);
      const tamperOffset = DATA_TRANSFER_FRAME_HEADER_BYTES + 1;
      mutated[tamperOffset] = byteAt(mutated, tamperOffset) ^ 0x80;
      return mutated;
    }
  }
}

function readReferencePackage(bytes: Buffer, reference: ReferencePackage) {
  return readAuthenticatedFrames(bytes, {
    ...context(),
    expectedTotalFrames: reference.totalFrames,
    expectedFinalAuthenticationChainDigest: reference.finalAuthenticationChainDigest,
  });
}

function expectFramingError(error: unknown, code: "PACKAGE_TAMPERED" | "PACKAGE_INCOMPLETE") {
  expect(error).toBeInstanceOf(DataTransferFramingError);
  expect(error).toMatchObject({ code });
  expect((error as Error).message).not.toContain(PAYLOAD_KEY.toString("hex"));
}

function expectFrameStateError(error: unknown) {
  expect(error).toBeInstanceOf(DataTransferFramingError);
  expect(error).toMatchObject({ code: "FRAME_STATE_INVALID" });
  expect((error as Error).message).not.toContain(PAYLOAD_KEY.toString("hex"));
}

describe("authenticated package frames", () => {
  test("permanently fails a writer after a post-AEAD system error without reusing its nonce", () => {
    const writer = new AuthenticatedFrameWriter(context());
    const input = {
      type: DataTransferFrameType.EntryData,
      flags: 1,
      entryOrdinal: 0,
      chunkIndex: 0,
      plainLength: 5,
      compressedBytes: Buffer.from("alpha"),
    } as const;
    const systemError = new Error("simulated authentication-chain hash failure");
    const createCipheriv = vi.spyOn(crypto, "createCipheriv");
    const createHash = vi.spyOn(crypto, "createHash").mockImplementationOnce(() => {
      throw systemError;
    });
    try {
      let firstFailure: unknown;
      try {
        writer.encrypt(input);
      } catch (error) {
        firstFailure = error;
      }
      expect(firstFailure).toBe(systemError);
      expect(writer.totalFrames).toBe(0n);
      expect(createCipheriv).toHaveBeenCalledOnce();

      let reuseFailure: unknown;
      try {
        writer.encrypt(input);
      } catch (error) {
        reuseFailure = error;
      }
      expectFrameStateError(reuseFailure);
      expect(createCipheriv).toHaveBeenCalledOnce();
    } finally {
      createHash.mockRestore();
      createCipheriv.mockRestore();
    }
  });

  test("permanently finishes a reader after successful finish", () => {
    const reference = encodeReferenceFrames();
    const first = reference.frames[0];
    if (!first) throw new Error("reference frame missing");
    const reader = new AuthenticatedFrameReader(context());
    reader.decrypt(first.headerBytes, payload(first));
    reader.finish(1n, first.authenticationChainDigest);

    for (const operation of [
      () => reader.decrypt(first.headerBytes, payload(first)),
      () => reader.finish(1n, first.authenticationChainDigest),
    ]) {
      let failure: unknown;
      try {
        operation();
      } catch (error) {
        failure = error;
      }
      expectFrameStateError(failure);
    }
  });

  test("permanently fails a reader after finish rejects an incomplete stream", () => {
    const reference = encodeReferenceFrames();
    const first = reference.frames[0];
    if (!first) throw new Error("reference frame missing");
    const reader = new AuthenticatedFrameReader(context());

    let finishFailure: unknown;
    try {
      reader.finish(1n, first.authenticationChainDigest);
    } catch (error) {
      finishFailure = error;
    }
    expectFramingError(finishFailure, "PACKAGE_INCOMPLETE");

    for (const operation of [
      () => reader.decrypt(first.headerBytes, payload(first)),
      () => reader.finish(0n, createInitialAuthenticationChainDigest()),
    ]) {
      let reuseFailure: unknown;
      try {
        operation();
      } catch (error) {
        reuseFailure = error;
      }
      expectFrameStateError(reuseFailure);
    }
  });

  test("permanently fails a reader after authentication failure", () => {
    const reference = encodeReferenceFrames();
    const first = reference.frames[0];
    if (!first) throw new Error("reference frame missing");
    const framePayload = payload(first);
    const tampered = Buffer.from(framePayload);
    tampered[0] = byteAt(tampered, 0) ^ 0x80;
    const reader = new AuthenticatedFrameReader(context());

    let authenticationFailure: unknown;
    try {
      reader.decrypt(first.headerBytes, tampered);
    } catch (error) {
      authenticationFailure = error;
    }
    expectFramingError(authenticationFailure, "PACKAGE_TAMPERED");

    for (const operation of [
      () => reader.decrypt(first.headerBytes, framePayload),
      () => reader.finish(0n, createInitialAuthenticationChainDigest()),
    ]) {
      let reuseFailure: unknown;
      try {
        operation();
      } catch (error) {
        reuseFailure = error;
      }
      expectFrameStateError(reuseFailure);
    }
  });

  test("clears authenticated plaintext and permanently fails after a reader post-auth system error", () => {
    const reference = encodeReferenceFrames();
    const first = reference.frames[0];
    if (!first) throw new Error("reference frame missing");
    const framePayload = payload(first);
    const systemError = new Error("simulated reader authentication-chain hash failure");
    const originalConcat = Buffer.concat;
    let authenticatedPlaintext: Buffer | undefined;
    const concat = vi.spyOn(Buffer, "concat").mockImplementation(((
      list: readonly Uint8Array[],
      totalLength?: number,
    ) => {
      const result =
        totalLength === undefined ? originalConcat(list) : originalConcat(list, totalLength);
      if (list.length === 2 && result.byteLength === first.ciphertext.byteLength) {
        authenticatedPlaintext = result;
      }
      return result;
    }) as typeof Buffer.concat);
    const createDecipheriv = vi.spyOn(crypto, "createDecipheriv");
    const createHash = vi.spyOn(crypto, "createHash").mockImplementationOnce(() => {
      throw systemError;
    });
    const reader = new AuthenticatedFrameReader(context());
    try {
      let firstFailure: unknown;
      try {
        reader.decrypt(first.headerBytes, framePayload);
      } catch (error) {
        firstFailure = error;
      }
      expect(firstFailure).toBe(systemError);
      expect(authenticatedPlaintext).toBeDefined();
      expect(authenticatedPlaintext?.every((byte) => byte === 0)).toBe(true);
      expect(createDecipheriv).toHaveBeenCalledOnce();

      let reuseFailure: unknown;
      try {
        reader.decrypt(first.headerBytes, framePayload);
      } catch (error) {
        reuseFailure = error;
      }
      expectFrameStateError(reuseFailure);
      expect(createDecipheriv).toHaveBeenCalledOnce();
    } finally {
      createHash.mockRestore();
      createDecipheriv.mockRestore();
      concat.mockRestore();
    }
  });

  test("matches a fixed independently generated AES-256-GCM frame vector", () => {
    const compressedBytes = Buffer.from("f348cdc9c90700", "hex");
    const originalInput = Buffer.from(compressedBytes);
    const writer = new AuthenticatedFrameWriter(
      context({ publicHeaderDigest: FIXED_VECTOR_HEADER_DIGEST }),
    );

    const frame = writer.encrypt({
      type: DataTransferFrameType.EntryData,
      flags: 1,
      entryOrdinal: 0x01020304,
      chunkIndex: 5,
      plainLength: 5,
      compressedBytes,
    });

    expect(frame.headerBytes.toString("hex")).toBe(
      "02010000000000000000000001020304000000050000000500000017",
    );
    expect(frame.headerBytes.byteLength).toBe(28);
    expect(frame.header).toEqual({
      type: DataTransferFrameType.EntryData,
      flags: 1,
      globalSequence: 0n,
      entryOrdinal: 0x01020304,
      chunkIndex: 5,
      plainLength: 5,
      cipherLength: compressedBytes.byteLength + DATA_TRANSFER_GCM_TAG_BYTES,
    });
    expect(frame.nonce.toString("hex")).toBe("010203040000000000000000");
    expect(frame.ciphertext.toString("hex")).toBe("d21d1094de9678");
    expect(frame.ciphertext.byteLength).toBe(compressedBytes.byteLength);
    expect(frame.authenticationTag.toString("hex")).toBe("8dc71b7421db880026305254b873ee98");
    expect(frame.authenticationTag.byteLength).toBe(16);
    expect(frame.authenticationChainDigest.toString("hex")).toBe(
      "cd5c713634d6ed4e9bcb1b8ab3d3876ebabbfebb2726295c9adb3137c7a087f5",
    );
    expect(createInitialAuthenticationChainDigest().toString("hex")).toBe(
      "cb9c8f7a5c6a57fc2f0bca85b9fde8024ff4c3cc6ee05fdda8bdb8906f39119c",
    );
    expect(compressedBytes).toEqual(originalInput);
  });

  test("binds the public header through its SHA-256 digest", () => {
    expect(computePublicHeaderDigest(PUBLIC_HEADER_BYTES)).toEqual(
      createHash("sha256").update(PUBLIC_HEADER_BYTES).digest(),
    );
    expect(PUBLIC_HEADER_DIGEST).toHaveLength(32);
  });

  test("round-trips multiple frames and does not modify source or encoded buffers", () => {
    const reference = encodeReferenceFrames();
    const encodedBefore = Buffer.from(reference.bytes);

    const decoded = readReferencePackage(reference.bytes, reference);

    expect(decoded.map((frame) => frame.header.globalSequence)).toEqual([0n, 1n, 2n]);
    expect(decoded.map((frame) => frame.compressedBytes.toString("utf8"))).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(reference.bytes).toEqual(encodedBefore);
  });

  test("accepts an authenticated empty frame and an empty frame stream", () => {
    const writer = new AuthenticatedFrameWriter(context());
    const frame = writer.encrypt({
      type: DataTransferFrameType.EntryData,
      flags: 1,
      entryOrdinal: 0,
      chunkIndex: 0,
      plainLength: 0,
      compressedBytes: Buffer.alloc(0),
    });
    const decoded = readAuthenticatedFrames(serializeFrame(frame), {
      ...context(),
      expectedTotalFrames: 1n,
      expectedFinalAuthenticationChainDigest: writer.finalAuthenticationChainDigest,
    });
    expect(decoded).toHaveLength(1);
    expect(decoded.at(0)?.compressedBytes).toHaveLength(0);

    expect(
      readAuthenticatedFrames(Buffer.alloc(0), {
        ...context(),
        expectedTotalFrames: 0n,
        expectedFinalAuthenticationChainDigest: createInitialAuthenticationChainDigest(),
      }),
    ).toEqual([]);
  });

  test.each([
    ["delete", "PACKAGE_TAMPERED"],
    ["insert", "PACKAGE_TAMPERED"],
    ["duplicate", "PACKAGE_TAMPERED"],
    ["swap", "PACKAGE_TAMPERED"],
    ["truncate", "PACKAGE_INCOMPLETE"],
    ["tamper", "PACKAGE_TAMPERED"],
  ] as const)("rejects %s frame mutation", (mutation, code) => {
    const reference = encodeReferenceFrames();
    const mutated = mutateFrames(reference.bytes, mutation);
    let producedFrames: ReturnType<typeof readReferencePackage> | undefined;

    try {
      producedFrames = readReferencePackage(mutated, reference);
      throw new Error("mutation was accepted");
    } catch (error) {
      expectFramingError(error, code);
    }
    expect(producedFrames).toBeUndefined();
  });

  test("mutation helpers alter the intended real serialized bytes", () => {
    const reference = encodeReferenceFrames();
    const [first, second, third] = splitReferenceFrames(reference.bytes);
    const deletion = mutateFrames(reference.bytes, "delete");
    const insertion = mutateFrames(reference.bytes, "insert");
    const duplication = mutateFrames(reference.bytes, "duplicate");
    const swap = mutateFrames(reference.bytes, "swap");
    const truncation = mutateFrames(reference.bytes, "truncate");
    const tamper = mutateFrames(reference.bytes, "tamper");

    expect(deletion).toEqual(Buffer.concat([first, third]));
    expect(deletion.byteLength).toBe(reference.bytes.byteLength - second.byteLength);
    expect(insertion.byteLength).toBe(reference.bytes.byteLength + 1);
    expect(insertion[first.byteLength]).toBe(0xff);
    expect(duplication.byteLength).toBe(reference.bytes.byteLength + second.byteLength);
    expect(swap.subarray(0, second.byteLength)).toEqual(second);
    expect(truncation.byteLength).toBe(reference.bytes.byteLength - 1);
    expect(tamper[DATA_TRANSFER_FRAME_HEADER_BYTES + 1]).toBe(
      byteAt(reference.bytes, DATA_TRANSFER_FRAME_HEADER_BYTES + 1) ^ 0x80,
    );
  });

  test.each([
    ["payload key", { payloadKey: Buffer.alloc(32, 0xa5) }],
    ["package id", { packageId: OTHER_PACKAGE_ID }],
    ["public header digest", { publicHeaderDigest: Buffer.alloc(32, 0xa5) }],
  ] as const)("rejects a frame under the wrong %s", (_name, override) => {
    const reference = encodeReferenceFrames();
    expect(() =>
      readAuthenticatedFrames(reference.bytes, {
        ...context(override),
        expectedTotalFrames: reference.totalFrames,
        expectedFinalAuthenticationChainDigest: reference.finalAuthenticationChainDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "PACKAGE_TAMPERED" }));
  });

  test("binds each frame to the SHA-256 of the previous authentication tag", () => {
    const original = encodeReferenceFrames("alpha");
    const alternate = encodeReferenceFrames("omega");
    const [, originalSecond, originalThird] = splitReferenceFrames(original.bytes);
    const [alternateFirst] = splitReferenceFrames(alternate.bytes);
    const wrongPreviousTagChain = Buffer.concat([alternateFirst, originalSecond, originalThird]);

    expect(() => readReferencePackage(wrongPreviousTagChain, original)).toThrowError(
      expect.objectContaining({ code: "PACKAGE_TAMPERED" }),
    );
  });

  test("rejects invalid key, package id, digest, and nonce prefix before use", () => {
    for (const override of [
      { payloadKey: Buffer.alloc(31) },
      { packageId: "123E4567-E89B-42D3-A456-426614174000" },
      { packageId: "not-a-package-id" },
      { publicHeaderDigest: Buffer.alloc(31) },
      { noncePrefix: Buffer.alloc(3) },
    ]) {
      expect(() => new AuthenticatedFrameWriter(context(override))).toThrowError(
        expect.objectContaining({ code: "PACKAGE_TAMPERED" }),
      );
    }
  });

  test("uses unique prefix-plus-sequence nonces and fails before the u64 maximum", () => {
    const nonces = Array.from({ length: 1_000 }, (_, sequence) =>
      createFrameNonce(NONCE_PREFIX, BigInt(sequence)).toString("hex"),
    );
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(nonces[0]).toBe("010203040000000000000000");
    expect(nonces[999]).toBe("0102030400000000000003e7");
    expect(createFrameNonce(NONCE_PREFIX, 0xfffffffffffffffen).subarray(4).toString("hex")).toBe(
      "fffffffffffffffe",
    );
    for (const invalid of [-1n, 0xffffffffffffffffn, 0x10000000000000000n]) {
      expect(() => createFrameNonce(NONCE_PREFIX, invalid)).toThrowError(
        expect.objectContaining({ code: "PACKAGE_TAMPERED" }),
      );
    }
  });

  test("creates independent four-byte random nonce prefixes", () => {
    const randomBytes = vi.spyOn(crypto, "randomBytes");
    try {
      const prefix = createFrameNoncePrefix();

      expect(randomBytes).toHaveBeenCalledOnce();
      expect(randomBytes).toHaveBeenCalledWith(4);
      expect(prefix).toHaveLength(4);
    } finally {
      randomBytes.mockRestore();
    }
  });

  test("rejects raw and compressed length overflow before encryption", () => {
    const writer = new AuthenticatedFrameWriter(context());
    expect(() =>
      writer.encrypt({
        type: DataTransferFrameType.EntryData,
        flags: 1,
        entryOrdinal: 0,
        chunkIndex: 0,
        plainLength: DATA_TRANSFER_CHUNK_BYTES + 1,
        compressedBytes: Buffer.alloc(1),
      }),
    ).toThrowError(expect.objectContaining({ code: "PACKAGE_TAMPERED" }));
    expect(() =>
      writer.encrypt({
        type: DataTransferFrameType.EntryData,
        flags: 1,
        entryOrdinal: 0,
        chunkIndex: 0,
        plainLength: 1,
        compressedBytes: Buffer.alloc(DATA_TRANSFER_CHUNK_BYTES + 1),
      }),
    ).toThrowError(expect.objectContaining({ code: "PACKAGE_TAMPERED" }));
    expect(writer.totalFrames).toBe(0n);
  });

  test.each([
    ["type", 0, 3],
    ["flags", 1, 2],
    ["reserved", 2, 1],
    ["sequence", 11, 1],
    ["entry ordinal AAD", 15, 5],
    ["chunk index AAD", 19, 1],
    ["plain length AAD", 23, 10],
    ["plain length", 20, 0xff],
    ["cipher length", 24, 0xff],
  ] as const)(
    "rejects a tampered frame-header %s before returning plaintext",
    (_name, offset, value) => {
      const reference = encodeReferenceFrames();
      const changed = Buffer.from(reference.bytes);
      changed[offset] = value;
      const reader = new AuthenticatedFrameReader(context());
      const payloadLength = changed.readUInt32BE(24);
      const payload = changed.subarray(
        DATA_TRANSFER_FRAME_HEADER_BYTES,
        DATA_TRANSFER_FRAME_HEADER_BYTES + Math.min(payloadLength, changed.byteLength),
      );
      let plaintext: Buffer | undefined;

      try {
        plaintext = reader.decrypt(
          changed.subarray(0, DATA_TRANSFER_FRAME_HEADER_BYTES),
          payload,
        ).compressedBytes;
        throw new Error("tampered header was accepted");
      } catch (error) {
        expectFramingError(error, "PACKAGE_TAMPERED");
      }
      expect(plaintext).toBeUndefined();
    },
  );

  test("rejects an incomplete header or encrypted payload without returning frames", () => {
    const reference = encodeReferenceFrames();
    for (const truncated of [
      reference.bytes.subarray(0, DATA_TRANSFER_FRAME_HEADER_BYTES - 1),
      reference.bytes.subarray(0, DATA_TRANSFER_FRAME_HEADER_BYTES + 1),
      reference.bytes.subarray(0, -1),
    ]) {
      let frames: ReturnType<typeof readReferencePackage> | undefined;
      try {
        frames = readReferencePackage(Buffer.from(truncated), reference);
        throw new Error("truncation was accepted");
      } catch (error) {
        expectFramingError(error, "PACKAGE_INCOMPLETE");
      }
      expect(frames).toBeUndefined();
    }
  });

  test("rejects trailing insertion, count mismatch, and final-chain mismatch", () => {
    const reference = encodeReferenceFrames();
    expect(() =>
      readReferencePackage(Buffer.concat([reference.bytes, Buffer.from([0])]), reference),
    ).toThrowError(expect.objectContaining({ code: "PACKAGE_TAMPERED" }));
    expect(() =>
      readAuthenticatedFrames(reference.bytes, {
        ...context(),
        expectedTotalFrames: reference.totalFrames + 1n,
        expectedFinalAuthenticationChainDigest: reference.finalAuthenticationChainDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "PACKAGE_INCOMPLETE" }));
    expect(() =>
      readAuthenticatedFrames(reference.bytes, {
        ...context(),
        expectedTotalFrames: reference.totalFrames,
        expectedFinalAuthenticationChainDigest: Buffer.alloc(32, 0xa5),
      }),
    ).toThrowError(expect.objectContaining({ code: "PACKAGE_TAMPERED" }));
  });
});

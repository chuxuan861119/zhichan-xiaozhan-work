import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import {
  DATA_TRANSFER_CHUNK_BYTES,
  DATA_TRANSFER_FRAME_HEADER_BYTES,
  DATA_TRANSFER_GCM_TAG_BYTES,
  type DataTransferFrameType,
  decodeFrameHeader,
  encodeFrameHeader,
  type TransferFrameHeader,
} from "../../shared/data-transfer/package-format.js";
import type { AppErrorCode } from "../../shared/ipc/result.js";

const AES_256_KEY_BYTES = 32;
const FRAME_NONCE_PREFIX_BYTES = 4;
const FRAME_NONCE_BYTES = 12;
const SHA_256_BYTES = 32;
const FIRST_UNAVAILABLE_SEQUENCE = 0xffffffffffffffffn;
const FRAME_AAD_DOMAIN = Buffer.from("ZXW-DATA-TRANSFER-FRAME-AAD-V1\0", "ascii");
const INITIAL_AUTHENTICATION_CHAIN_DIGEST = crypto
  .createHash("sha256")
  .update(Buffer.from("ZXW-DATA-TRANSFER-FRAME-CHAIN-INITIAL-V1", "ascii"))
  .digest();
const CANONICAL_PACKAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GCM_AUTHENTICATION_FAILURE_MESSAGE = "Unsupported state or unable to authenticate data";

type DataTransferFramingErrorCode =
  | Extract<AppErrorCode, "PACKAGE_INCOMPLETE" | "PACKAGE_TAMPERED">
  | "FRAME_STATE_INVALID";

const FRAMING_ERROR_MESSAGES: Record<DataTransferFramingErrorCode, string> = {
  FRAME_STATE_INVALID: "认证帧实例状态无效。",
  PACKAGE_INCOMPLETE: "数据包不完整。",
  PACKAGE_TAMPERED: "数据包完整性验证失败。",
};

export class DataTransferFramingError extends Error {
  constructor(readonly code: DataTransferFramingErrorCode) {
    super(FRAMING_ERROR_MESSAGES[code]);
    this.name = "DataTransferFramingError";
  }
}

export type AuthenticatedFrameContext = Readonly<{
  payloadKey: Buffer;
  packageId: string;
  publicHeaderDigest: Buffer;
  noncePrefix: Buffer;
}>;

export type AuthenticatedFrameInput = Readonly<{
  type: DataTransferFrameType;
  flags: number;
  entryOrdinal: number;
  chunkIndex: number;
  plainLength: number;
  compressedBytes: Buffer;
}>;

export type EncodedAuthenticatedFrame = Readonly<{
  header: TransferFrameHeader;
  headerBytes: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  authenticationTag: Buffer;
  authenticationChainDigest: Buffer;
}>;

export type DecodedAuthenticatedFrame = Readonly<{
  header: TransferFrameHeader;
  compressedBytes: Buffer;
  authenticationChainDigest: Buffer;
}>;

function packageTampered(): DataTransferFramingError {
  return new DataTransferFramingError("PACKAGE_TAMPERED");
}

function packageIncomplete(): DataTransferFramingError {
  return new DataTransferFramingError("PACKAGE_INCOMPLETE");
}

function frameStateInvalid(): DataTransferFramingError {
  return new DataTransferFramingError("FRAME_STATE_INVALID");
}

function isBufferOfLength(value: unknown, length: number): value is Buffer {
  return Buffer.isBuffer(value) && value.byteLength === length;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function validateContext(context: AuthenticatedFrameContext): void {
  if (
    !isBufferOfLength(context.payloadKey, AES_256_KEY_BYTES) ||
    !CANONICAL_PACKAGE_ID_PATTERN.test(context.packageId) ||
    !isBufferOfLength(context.publicHeaderDigest, SHA_256_BYTES) ||
    !isBufferOfLength(context.noncePrefix, FRAME_NONCE_PREFIX_BYTES)
  ) {
    throw packageTampered();
  }
}

function isRecognizedFrameHeaderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("Invalid frame") ||
      error.message.startsWith("Invalid manifest frame"))
  );
}

function decodeAuthenticatedFrameHeader(bytes: Uint8Array): TransferFrameHeader {
  try {
    return decodeFrameHeader(bytes);
  } catch (error) {
    if (isRecognizedFrameHeaderError(error)) throw packageTampered();
    throw error;
  }
}

function encodeAuthenticatedFrameHeader(header: TransferFrameHeader): Buffer {
  try {
    return Buffer.from(encodeFrameHeader(header));
  } catch (error) {
    if (isRecognizedFrameHeaderError(error)) throw packageTampered();
    throw error;
  }
}

function isGcmAuthenticationFailure(error: unknown): boolean {
  return error instanceof Error && error.message === GCM_AUTHENTICATION_FAILURE_MESSAGE;
}

function authenticationChainDigest(authenticationTag: Buffer): Buffer {
  return crypto.createHash("sha256").update(authenticationTag).digest();
}

function validateExpectedCompletion(
  expectedTotalFrames: bigint,
  expectedFinalAuthenticationChainDigest: Buffer,
): void {
  if (
    typeof expectedTotalFrames !== "bigint" ||
    expectedTotalFrames < 0n ||
    expectedTotalFrames > FIRST_UNAVAILABLE_SEQUENCE ||
    !isBufferOfLength(expectedFinalAuthenticationChainDigest, SHA_256_BYTES)
  ) {
    throw packageTampered();
  }
}

function createFrameAad(
  packageId: string,
  publicHeaderDigest: Buffer,
  headerBytes: Uint8Array,
  previousAuthenticationChainDigest: Buffer,
): Buffer {
  return Buffer.concat([
    FRAME_AAD_DOMAIN,
    Buffer.from(packageId, "ascii"),
    publicHeaderDigest,
    headerBytes,
    previousAuthenticationChainDigest,
  ]);
}

function asBufferView(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function computePublicHeaderDigest(publicHeaderBytes: Uint8Array): Buffer {
  if (!isUint8Array(publicHeaderBytes)) throw packageTampered();
  return crypto.createHash("sha256").update(publicHeaderBytes).digest();
}

export function createInitialAuthenticationChainDigest(): Buffer {
  return Buffer.from(INITIAL_AUTHENTICATION_CHAIN_DIGEST);
}

export function createFrameNoncePrefix(): Buffer {
  return crypto.randomBytes(FRAME_NONCE_PREFIX_BYTES);
}

export function createFrameNonce(noncePrefix: Buffer, globalSequence: bigint): Buffer {
  if (
    !isBufferOfLength(noncePrefix, FRAME_NONCE_PREFIX_BYTES) ||
    typeof globalSequence !== "bigint" ||
    globalSequence < 0n ||
    globalSequence >= FIRST_UNAVAILABLE_SEQUENCE
  ) {
    throw packageTampered();
  }
  const nonce = Buffer.alloc(FRAME_NONCE_BYTES);
  noncePrefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(globalSequence, FRAME_NONCE_PREFIX_BYTES);
  return nonce;
}

export class AuthenticatedFrameWriter {
  readonly #payloadKey: Buffer;
  readonly #packageId: string;
  readonly #publicHeaderDigest: Buffer;
  readonly #noncePrefix: Buffer;
  #nextGlobalSequence = 0n;
  #authenticationChainDigest = createInitialAuthenticationChainDigest();
  #state: "active" | "failed" = "active";

  constructor(context: AuthenticatedFrameContext) {
    validateContext(context);
    this.#payloadKey = context.payloadKey;
    this.#packageId = context.packageId;
    this.#publicHeaderDigest = Buffer.from(context.publicHeaderDigest);
    this.#noncePrefix = Buffer.from(context.noncePrefix);
  }

  get totalFrames(): bigint {
    return this.#nextGlobalSequence;
  }

  get finalAuthenticationChainDigest(): Buffer {
    return Buffer.from(this.#authenticationChainDigest);
  }

  encrypt(input: AuthenticatedFrameInput): EncodedAuthenticatedFrame {
    if (this.#state !== "active") throw frameStateInvalid();
    if (
      !Buffer.isBuffer(input.compressedBytes) ||
      input.compressedBytes.byteLength > DATA_TRANSFER_CHUNK_BYTES
    ) {
      throw packageTampered();
    }
    const nonce = createFrameNonce(this.#noncePrefix, this.#nextGlobalSequence);
    const header: TransferFrameHeader = Object.freeze({
      type: input.type,
      flags: input.flags,
      globalSequence: this.#nextGlobalSequence,
      entryOrdinal: input.entryOrdinal,
      chunkIndex: input.chunkIndex,
      plainLength: input.plainLength,
      cipherLength: input.compressedBytes.byteLength + DATA_TRANSFER_GCM_TAG_BYTES,
    });
    const headerBytes = encodeAuthenticatedFrameHeader(header);
    const aad = createFrameAad(
      this.#packageId,
      this.#publicHeaderDigest,
      headerBytes,
      this.#authenticationChainDigest,
    );
    this.#state = "failed";
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#payloadKey, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(input.compressedBytes), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    const nextAuthenticationChainDigest = authenticationChainDigest(authenticationTag);
    const result = Object.freeze({
      header,
      headerBytes,
      nonce,
      ciphertext,
      authenticationTag,
      authenticationChainDigest: Buffer.from(nextAuthenticationChainDigest),
    });

    this.#nextGlobalSequence += 1n;
    this.#authenticationChainDigest = nextAuthenticationChainDigest;
    this.#state = "active";
    return result;
  }
}

export class AuthenticatedFrameReader {
  readonly #payloadKey: Buffer;
  readonly #packageId: string;
  readonly #publicHeaderDigest: Buffer;
  readonly #noncePrefix: Buffer;
  #nextGlobalSequence = 0n;
  #authenticationChainDigest = createInitialAuthenticationChainDigest();
  #state: "active" | "finished" | "failed" = "active";

  constructor(context: AuthenticatedFrameContext) {
    validateContext(context);
    this.#payloadKey = context.payloadKey;
    this.#packageId = context.packageId;
    this.#publicHeaderDigest = Buffer.from(context.publicHeaderDigest);
    this.#noncePrefix = Buffer.from(context.noncePrefix);
  }

  get totalFrames(): bigint {
    return this.#nextGlobalSequence;
  }

  get finalAuthenticationChainDigest(): Buffer {
    return Buffer.from(this.#authenticationChainDigest);
  }

  decrypt(headerBytesInput: Uint8Array, payloadInput: Uint8Array): DecodedAuthenticatedFrame {
    if (this.#state !== "active") throw frameStateInvalid();
    this.#state = "failed";
    let prefix: Buffer | undefined;
    let suffix: Buffer | undefined;
    let compressedBytes: Buffer | undefined;
    let delivered = false;
    try {
      if (
        !isUint8Array(headerBytesInput) ||
        headerBytesInput.byteLength !== DATA_TRANSFER_FRAME_HEADER_BYTES ||
        !isUint8Array(payloadInput)
      ) {
        throw packageTampered();
      }
      const header = decodeAuthenticatedFrameHeader(headerBytesInput);
      if (header.globalSequence !== this.#nextGlobalSequence) throw packageTampered();
      if (payloadInput.byteLength !== header.cipherLength) throw packageTampered();
      const ciphertextLength = header.cipherLength - DATA_TRANSFER_GCM_TAG_BYTES;
      if (ciphertextLength < 0 || ciphertextLength > DATA_TRANSFER_CHUNK_BYTES) {
        throw packageTampered();
      }

      const nonce = createFrameNonce(this.#noncePrefix, header.globalSequence);
      const payload = asBufferView(payloadInput);
      const ciphertext = payload.subarray(0, ciphertextLength);
      const authenticationTag = payload.subarray(ciphertextLength);
      if (authenticationTag.byteLength !== DATA_TRANSFER_GCM_TAG_BYTES) throw packageTampered();
      const aad = createFrameAad(
        this.#packageId,
        this.#publicHeaderDigest,
        headerBytesInput,
        this.#authenticationChainDigest,
      );
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.#payloadKey, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(authenticationTag);
      prefix = decipher.update(ciphertext);
      try {
        suffix = decipher.final();
      } catch (error) {
        if (isGcmAuthenticationFailure(error)) throw packageTampered();
        throw error;
      }
      compressedBytes = Buffer.concat([prefix, suffix]);
      if (compressedBytes.byteLength !== ciphertextLength) {
        throw packageTampered();
      }

      const nextAuthenticationChainDigest = authenticationChainDigest(authenticationTag);
      const result = Object.freeze({
        header,
        compressedBytes,
        authenticationChainDigest: Buffer.from(nextAuthenticationChainDigest),
      });
      this.#nextGlobalSequence += 1n;
      this.#authenticationChainDigest = nextAuthenticationChainDigest;
      this.#state = "active";
      delivered = true;
      return result;
    } finally {
      prefix?.fill(0);
      suffix?.fill(0);
      if (!delivered) compressedBytes?.fill(0);
    }
  }

  finish(expectedTotalFrames: bigint, expectedFinalAuthenticationChainDigest: Buffer): void {
    if (this.#state !== "active") throw frameStateInvalid();
    this.#state = "failed";
    validateExpectedCompletion(expectedTotalFrames, expectedFinalAuthenticationChainDigest);
    if (this.#nextGlobalSequence < expectedTotalFrames) throw packageIncomplete();
    if (this.#nextGlobalSequence > expectedTotalFrames) throw packageTampered();
    if (
      !crypto.timingSafeEqual(
        this.#authenticationChainDigest,
        expectedFinalAuthenticationChainDigest,
      )
    ) {
      throw packageTampered();
    }
    this.#state = "finished";
  }
}

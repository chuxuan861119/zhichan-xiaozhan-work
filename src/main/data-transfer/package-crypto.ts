import { Buffer } from "node:buffer";
import crypto, {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { ZodError } from "zod";
import {
  DATA_TRANSFER_GCM_TAG_BYTES,
  DATA_TRANSFER_PASSWORD_CHECK_BLOCK_BYTES,
  DATA_TRANSFER_PASSWORD_CHECK_NONCE_BYTES,
  type DataTransferPublicHeader,
  DataTransferPublicHeaderSchema,
  encodePublicHeaderMacPayload,
} from "../../shared/data-transfer/package-format.js";
import type { AppErrorCode } from "../../shared/ipc/result.js";

const KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const PASSWORD_CHECK_PLAINTEXT = "ZXW-PASSWORD-CHECK-V1";
const PASSWORD_CHECK_AAD = Buffer.from("ZXW-DATA-TRANSFER-PASSWORD-CHECK-AAD-V1", "ascii");
const GCM_AUTHENTICATION_FAILURE_MESSAGE = "Unsupported state or unable to authenticate data";
const HKDF_SALT = Buffer.from("ZXW-DATA-TRANSFER-HKDF-SHA256-V1", "ascii");
const HKDF_INFO = Object.freeze({
  passwordCheckKey: "ZXW-DATA-TRANSFER-PASSWORD-CHECK-KEY-V1",
  headerAuthKey: "ZXW-DATA-TRANSFER-HEADER-AUTH-KEY-V1",
  payloadKey: "ZXW-DATA-TRANSFER-PAYLOAD-KEY-V1",
});
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type SafeScryptParams = Readonly<{
  algorithm: "scrypt";
  N: 131_072;
  r: 8;
  p: 1;
  maxmemBytes: 268_435_456;
  derivedKeyBytes: 32;
}>;

type ScryptParamsInput = Readonly<{
  algorithm: string;
  N: number;
  r: number;
  p: number;
  maxmemBytes: number;
  derivedKeyBytes: number;
}>;

export const SAFE_SCRYPT_PARAMS: SafeScryptParams = Object.freeze({
  algorithm: "scrypt",
  N: 131_072,
  r: 8,
  p: 1,
  maxmemBytes: 268_435_456,
  derivedKeyBytes: 32,
});

type DataTransferCryptoErrorCode = Extract<
  AppErrorCode,
  "PASSWORD_OR_PACKAGE_INVALID" | "PACKAGE_TAMPERED"
>;

const CRYPTO_ERROR_MESSAGES: Record<DataTransferCryptoErrorCode, string> = {
  PASSWORD_OR_PACKAGE_INVALID: "密码不正确或数据包无效。",
  PACKAGE_TAMPERED: "数据包完整性验证失败。",
};

export class DataTransferCryptoError extends Error {
  constructor(readonly code: DataTransferCryptoErrorCode) {
    super(CRYPTO_ERROR_MESSAGES[code]);
    this.name = "DataTransferCryptoError";
  }
}

export class DerivedPackageKeys {
  #destroyed = false;

  constructor(
    readonly passwordCheckKey: Buffer,
    readonly headerAuthKey: Buffer,
    readonly payloadKey: Buffer,
  ) {}

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.passwordCheckKey.fill(0);
    this.headerAuthKey.fill(0);
    this.payloadKey.fill(0);
  }
}

function passwordOrPackageInvalid(): DataTransferCryptoError {
  return new DataTransferCryptoError("PASSWORD_OR_PACKAGE_INVALID");
}

function isExactScryptParams(value: ScryptParamsInput): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Object.keys(value).length !== Object.keys(SAFE_SCRYPT_PARAMS).length) return false;
  return (
    value.algorithm === SAFE_SCRYPT_PARAMS.algorithm &&
    value.N === SAFE_SCRYPT_PARAMS.N &&
    value.r === SAFE_SCRYPT_PARAMS.r &&
    value.p === SAFE_SCRYPT_PARAMS.p &&
    value.maxmemBytes === SAFE_SCRYPT_PARAMS.maxmemBytes &&
    value.derivedKeyBytes === SAFE_SCRYPT_PARAMS.derivedKeyBytes
  );
}

function isBufferOfLength(value: unknown, length: number): value is Buffer {
  return Buffer.isBuffer(value) && value.byteLength === length;
}

function isCanonicalPackageId(packageId: unknown): packageId is string {
  return typeof packageId === "string" && CANONICAL_UUID_PATTERN.test(packageId);
}

function deriveMaster(passwordBytes: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passwordBytes,
      salt,
      SAFE_SCRYPT_PARAMS.derivedKeyBytes,
      {
        N: SAFE_SCRYPT_PARAMS.N,
        r: SAFE_SCRYPT_PARAMS.r,
        p: SAFE_SCRYPT_PARAMS.p,
        maxmem: SAFE_SCRYPT_PARAMS.maxmemBytes,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function expandKey(master: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", master, HKDF_SALT, info, KEY_BYTES));
}

function isGcmAuthenticationFailure(error: unknown): boolean {
  return error instanceof Error && error.message === GCM_AUTHENTICATION_FAILURE_MESSAGE;
}

export async function derivePackageKeys(
  password: string,
  salt: Buffer,
  params: ScryptParamsInput = SAFE_SCRYPT_PARAMS,
): Promise<DerivedPackageKeys> {
  if (!isExactScryptParams(params) || !isBufferOfLength(salt, KEY_BYTES)) {
    throw passwordOrPackageInvalid();
  }
  if (typeof password !== "string") throw passwordOrPackageInvalid();
  const normalizedPassword = password.normalize("NFC");
  const codePointLength = Array.from(normalizedPassword).length;
  if (codePointLength < 12 || codePointLength > 128) throw passwordOrPackageInvalid();

  const passwordBytes = Buffer.from(normalizedPassword, "utf8");
  let master: Buffer | undefined;
  const createdKeys: Buffer[] = [];
  try {
    master = await deriveMaster(passwordBytes, salt);
    const passwordCheckKey = expandKey(master, HKDF_INFO.passwordCheckKey);
    createdKeys.push(passwordCheckKey);
    const headerAuthKey = expandKey(master, HKDF_INFO.headerAuthKey);
    createdKeys.push(headerAuthKey);
    const payloadKey = expandKey(master, HKDF_INFO.payloadKey);
    createdKeys.push(payloadKey);
    return new DerivedPackageKeys(passwordCheckKey, headerAuthKey, payloadKey);
  } catch (error) {
    for (const key of createdKeys) key.fill(0);
    throw error;
  } finally {
    passwordBytes.fill(0);
    master?.fill(0);
  }
}

export function createPasswordCheckBlock(passwordCheckKey: Buffer, nonce?: Buffer): Buffer {
  if (!isBufferOfLength(passwordCheckKey, KEY_BYTES)) throw passwordOrPackageInvalid();
  const actualNonce = nonce ?? randomBytes(GCM_NONCE_BYTES);
  if (!isBufferOfLength(actualNonce, GCM_NONCE_BYTES)) throw passwordOrPackageInvalid();
  const plaintext = Buffer.from(PASSWORD_CHECK_PLAINTEXT, "ascii");
  try {
    const cipher = createCipheriv("aes-256-gcm", passwordCheckKey, actualNonce);
    cipher.setAAD(PASSWORD_CHECK_AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([actualNonce, ciphertext, tag]);
  } finally {
    plaintext.fill(0);
  }
}

export function verifyPasswordCheckBlock(passwordCheckKey: Buffer, block: Buffer): boolean {
  if (
    !isBufferOfLength(passwordCheckKey, KEY_BYTES) ||
    !isBufferOfLength(block, DATA_TRANSFER_PASSWORD_CHECK_BLOCK_BYTES)
  ) {
    return false;
  }
  const nonce = block.subarray(0, DATA_TRANSFER_PASSWORD_CHECK_NONCE_BYTES);
  const ciphertext = block.subarray(
    DATA_TRANSFER_PASSWORD_CHECK_NONCE_BYTES,
    -DATA_TRANSFER_GCM_TAG_BYTES,
  );
  const tag = block.subarray(-DATA_TRANSFER_GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", passwordCheckKey, nonce);
  decipher.setAAD(PASSWORD_CHECK_AAD);
  decipher.setAuthTag(tag);
  const prefix = decipher.update(ciphertext);
  let suffix: Buffer;
  try {
    suffix = decipher.final();
  } catch (error) {
    prefix.fill(0);
    if (isGcmAuthenticationFailure(error)) return false;
    throw error;
  }
  const plaintext = Buffer.concat([prefix, suffix]);
  prefix.fill(0);
  suffix.fill(0);
  const expected = Buffer.from(PASSWORD_CHECK_PLAINTEXT, "ascii");
  try {
    return plaintext.byteLength === expected.byteLength && timingSafeEqual(plaintext, expected);
  } finally {
    plaintext.fill(0);
    expected.fill(0);
  }
}

export function computePublicHeaderMac(
  headerAuthKey: Buffer,
  header: DataTransferPublicHeader,
): Buffer {
  if (!isBufferOfLength(headerAuthKey, KEY_BYTES)) throw passwordOrPackageInvalid();
  const payload = Buffer.from(encodePublicHeaderMacPayload(header));
  try {
    return createHmac("sha256", headerAuthKey).update(payload).digest();
  } finally {
    payload.fill(0);
  }
}

export function verifyPublicHeaderMac(
  headerAuthKey: Buffer,
  header: DataTransferPublicHeader,
): boolean {
  if (!isBufferOfLength(headerAuthKey, KEY_BYTES)) return false;
  if (typeof header?.headerMacHex !== "string" || !/^[0-9a-f]{64}$/u.test(header.headerMacHex)) {
    return false;
  }
  let expected: Buffer;
  try {
    expected = computePublicHeaderMac(headerAuthKey, header);
  } catch (error) {
    if (error instanceof ZodError) return false;
    throw error;
  }
  const supplied = Buffer.from(header.headerMacHex, "hex");
  try {
    return timingSafeEqual(expected, supplied);
  } finally {
    expected.fill(0);
    supplied.fill(0);
  }
}

export async function verifyPassword(
  password: string,
  headerInput: DataTransferPublicHeader,
): Promise<DerivedPackageKeys> {
  let header: DataTransferPublicHeader;
  try {
    header = DataTransferPublicHeaderSchema.parse(headerInput);
  } catch (error) {
    if (error instanceof ZodError) throw passwordOrPackageInvalid();
    throw error;
  }
  if (!isCanonicalPackageId(header.packageId)) throw passwordOrPackageInvalid();

  const salt = Buffer.from(header.saltHex, "hex");
  const passwordCheck = Buffer.from(header.passwordCheckHex, "hex");
  let keys: DerivedPackageKeys | undefined;
  try {
    keys = await derivePackageKeys(password, salt, header.kdf);
    const passwordCheckValid = verifyPasswordCheckBlock(keys.passwordCheckKey, passwordCheck);
    const headerMacValid = verifyPublicHeaderMac(keys.headerAuthKey, header);
    if (!passwordCheckValid || !headerMacValid) throw passwordOrPackageInvalid();
    return keys;
  } catch (error) {
    keys?.destroy();
    throw error;
  } finally {
    salt.fill(0);
    passwordCheck.fill(0);
  }
}

import { Buffer } from "node:buffer";
import crypto, { createDecipheriv } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  DATA_TRANSFER_PASSWORD_CHECK_BLOCK_BYTES,
  DATA_TRANSFER_PASSWORD_CHECK_PLAINTEXT_BYTES,
  type DataTransferPublicHeader,
} from "../../shared/data-transfer/package-format.js";
import {
  computePublicHeaderMac,
  createPasswordCheckBlock,
  DataTransferCryptoError,
  DerivedPackageKeys,
  derivePackageKeys,
  SAFE_SCRYPT_PARAMS,
  verifyPassword,
  verifyPasswordCheckBlock,
  verifyPublicHeaderMac,
} from "./package-crypto.js";

const FIXED_PASSWORD = "专利 transfer 密码 phrase";
const FIXED_SALT = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const CHECK_NONCE = Buffer.from("a0a1a2a3a4a5a6a7a8a9aaab", "hex");
const PACKAGE_ID = "123e4567-e89b-42d3-a456-426614174000";

// These are protocol vectors, not values recomputed by the implementation under test.
const DERIVED_KEY_VECTOR = {
  passwordCheckKey: "bb63ff8d4ab5011645042e484269198f08f4a6b4fa9653f1f16ab40831710bd2",
  headerAuthKey: "a9845d377addcf53c25428f9db31d7ebaf1734836d69ea9ad9371b0ce49a6ce2",
  payloadKey: "4d54bad3a6730ef4020ed0638836320a9fd37b36beb365a0a14ef7891e8d56ce",
} as const;
const PASSWORD_CHECK_VECTOR =
  "a0a1a2a3a4a5a6a7a8a9aaab2fb6097e395bb29f74f51dcacd29491dd86eac506552d235bfd8457fe61993f3e49f5beac8";
const HEADER_MAC_VECTOR = "1ce7ddee1fe122c52d7ad533db4adb57f6471890413a2f5b0a4334f46f981797";

function headerWith(passwordCheckHex: string, headerMacHex = "00".repeat(32)) {
  return {
    packageFormatVersion: 2,
    packageId: PACKAGE_ID,
    minimumImporterVersion: "0.1.0",
    kdf: SAFE_SCRYPT_PARAMS,
    saltHex: FIXED_SALT.toString("hex"),
    noncePrefixHex: "01020304",
    passwordCheckHex,
    passwordHint: "fixture hint",
    headerMacHex,
  } satisfies DataTransferPublicHeader;
}

function expectStableCryptoError(
  error: unknown,
  code: "PASSWORD_OR_PACKAGE_INVALID" | "PACKAGE_TAMPERED",
) {
  expect(error).toBeInstanceOf(DataTransferCryptoError);
  expect(error).toMatchObject({ code });
  expect((error as Error).message).not.toContain(FIXED_PASSWORD);
  expect((error as Error).message).not.toContain(FIXED_SALT.toString("hex"));
  return { code: (error as DataTransferCryptoError).code, message: (error as Error).message };
}

async function expectRejectedBeforeAsyncWork(operation: Promise<DerivedPackageKeys>) {
  let settled = false;
  let failure: unknown;
  const handled = operation.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(true);
  await handled;
  expect(failure).toMatchObject({ code: "PASSWORD_OR_PACKAGE_INVALID" });
}

describe("package cryptography", () => {
  let fixedKeys: DerivedPackageKeys;
  let validHeader: DataTransferPublicHeader;

  beforeAll(async () => {
    fixedKeys = await derivePackageKeys(FIXED_PASSWORD, FIXED_SALT);
    const passwordCheck = createPasswordCheckBlock(fixedKeys.passwordCheckKey, CHECK_NONCE);
    const unsigned = headerWith(passwordCheck.toString("hex"));
    const headerMac = computePublicHeaderMac(fixedKeys.headerAuthKey, unsigned);
    validHeader = headerWith(passwordCheck.toString("hex"), headerMac.toString("hex"));
  });

  afterAll(() => fixedKeys.destroy());

  test("publishes the fixed safe scrypt parameters", () => {
    expect(SAFE_SCRYPT_PARAMS).toEqual({
      algorithm: "scrypt",
      N: 131_072,
      r: 8,
      p: 1,
      maxmemBytes: 256 * 1024 * 1024,
      derivedKeyBytes: 32,
    });
    expect(Object.isFrozen(SAFE_SCRYPT_PARAMS)).toBe(true);
  });

  test("derives the three separated protocol keys from the fixed scrypt/HKDF vector", () => {
    expect({
      passwordCheckKey: fixedKeys.passwordCheckKey.toString("hex"),
      headerAuthKey: fixedKeys.headerAuthKey.toString("hex"),
      payloadKey: fixedKeys.payloadKey.toString("hex"),
    }).toEqual(DERIVED_KEY_VECTOR);
    expect(new Set(Object.values(DERIVED_KEY_VECTOR))).toHaveLength(3);
  });

  test("normalizes passwords to NFC before deriving", async () => {
    const composed = await derivePackageKeys("é密码 phrase long", FIXED_SALT);
    const decomposed = await derivePackageKeys("e\u0301密码 phrase long", FIXED_SALT);
    try {
      expect(decomposed.passwordCheckKey).toEqual(composed.passwordCheckKey);
      expect(decomposed.headerAuthKey).toEqual(composed.headerAuthKey);
      expect(decomposed.payloadKey).toEqual(composed.payloadKey);
    } finally {
      composed.destroy();
      decomposed.destroy();
    }
  });

  test.each(["中文 密码 phrase", "x".repeat(128)])(
    "accepts a password within the code-point boundary: %s",
    async (password) => {
      expect(Array.from(password.normalize("NFC"))).toHaveLength(
        password === "中文 密码 phrase" ? 12 : 128,
      );
      const keys = await derivePackageKeys(password, FIXED_SALT);
      try {
        expect(keys.payloadKey).toHaveLength(32);
      } finally {
        keys.destroy();
      }
    },
  );

  test.each(["x".repeat(11), "x".repeat(129)])(
    "rejects a password outside the code-point boundary before expensive work",
    async (password) => {
      await expectRejectedBeforeAsyncWork(derivePackageKeys(password, FIXED_SALT));
    },
  );

  test("rejects salt and KDF parameter attacks before expensive work", async () => {
    const attacks: Array<() => Promise<DerivedPackageKeys>> = [
      () => derivePackageKeys(FIXED_PASSWORD, Buffer.alloc(31)),
      () => derivePackageKeys(FIXED_PASSWORD, FIXED_SALT, { ...SAFE_SCRYPT_PARAMS, N: 2 }),
      () =>
        derivePackageKeys(FIXED_PASSWORD, FIXED_SALT, {
          ...SAFE_SCRYPT_PARAMS,
          algorithm: "pbkdf2",
        }),
      () =>
        derivePackageKeys(FIXED_PASSWORD, FIXED_SALT, {
          ...SAFE_SCRYPT_PARAMS,
          maxmemBytes: SAFE_SCRYPT_PARAMS.maxmemBytes + 1,
        }),
      () =>
        derivePackageKeys(FIXED_PASSWORD, FIXED_SALT, {
          ...SAFE_SCRYPT_PARAMS,
          injected: true,
        } as typeof SAFE_SCRYPT_PARAMS),
    ];
    for (const attack of attacks) {
      await expectRejectedBeforeAsyncWork(attack());
    }
  });

  test("zeros the exact master buffer after successful expansion", async () => {
    const originalFill = Buffer.prototype.fill;
    const zeroedKeyBuffers: Array<{ buffer: Buffer; wasNonZero: boolean }> = [];
    Buffer.prototype.fill = function (this: Buffer, ...args: unknown[]) {
      if (args[0] === 0 && this.byteLength === 32) {
        zeroedKeyBuffers.push({ buffer: this, wasNonZero: this.some((byte) => byte !== 0) });
      }
      return Reflect.apply(originalFill, this, args);
    } as Buffer["fill"];
    let keys: DerivedPackageKeys | undefined;
    try {
      keys = await derivePackageKeys(FIXED_PASSWORD, FIXED_SALT);
      expect(zeroedKeyBuffers).toHaveLength(1);
      expect(zeroedKeyBuffers[0]?.wasNonZero).toBe(true);
      expect(zeroedKeyBuffers[0]?.buffer).toEqual(Buffer.alloc(32));
    } finally {
      Buffer.prototype.fill = originalFill;
      keys?.destroy();
    }
  });

  test.each([2, 3])(
    "zeros the master and all prior keys when HKDF expansion %s fails",
    async (failureCall) => {
      const systemError = new Error(`hkdf failure ${failureCall}`);
      const masterReferences: Buffer[] = [];
      const createdKeys: Buffer[] = [];
      const hkdfOutputs = new Set<unknown>();
      const originalHkdfSync = crypto.hkdfSync;
      const originalFrom = Buffer.from;
      let masterWasNonZero = false;
      let callCount = 0;
      crypto.hkdfSync = ((...args: unknown[]) => {
        const master = args[1];
        if (!Buffer.isBuffer(master)) throw new Error("Expected Buffer master key");
        masterReferences.push(master);
        masterWasNonZero ||= master.some((byte) => byte !== 0);
        callCount += 1;
        if (callCount === failureCall) throw systemError;
        const output = Reflect.apply(originalHkdfSync, crypto, args);
        hkdfOutputs.add(output);
        return output;
      }) as typeof crypto.hkdfSync;
      Buffer.from = ((...args: unknown[]) => {
        const key = Reflect.apply(originalFrom, Buffer, args) as Buffer;
        if (hkdfOutputs.has(args[0])) createdKeys.push(key);
        return key;
      }) as typeof Buffer.from;

      let result: unknown;
      try {
        result = await derivePackageKeys(FIXED_PASSWORD, FIXED_SALT).then(
          (keys) => {
            keys.destroy();
            return "accepted";
          },
          (error: unknown) => error,
        );
      } finally {
        Buffer.from = originalFrom;
        crypto.hkdfSync = originalHkdfSync;
      }
      expect(result).toBe(systemError);
      expect(masterReferences).toHaveLength(failureCall);
      expect(new Set(masterReferences)).toHaveLength(1);
      expect(masterWasNonZero).toBe(true);
      expect(masterReferences[0]).toEqual(Buffer.alloc(32));
      expect(createdKeys).toHaveLength(failureCall - 1);
      expect(createdKeys.length).toBeGreaterThan(0);
      for (const key of createdKeys) expect(key).toEqual(Buffer.alloc(32));
    },
  );

  test("destroy is idempotent and zeros every derived key", async () => {
    const keys = await derivePackageKeys("destroy test phrase", FIXED_SALT);
    keys.destroy();
    keys.destroy();
    expect(keys.passwordCheckKey).toEqual(Buffer.alloc(32));
    expect(keys.headerAuthKey).toEqual(Buffer.alloc(32));
    expect(keys.payloadKey).toEqual(Buffer.alloc(32));
  });

  test("uses the specified 21-byte plaintext and fixed 49-byte verifier vector", () => {
    expect(Buffer.byteLength("ZXW-PASSWORD-CHECK-V1", "utf8")).toBe(
      DATA_TRANSFER_PASSWORD_CHECK_PLAINTEXT_BYTES,
    );
    const block = createPasswordCheckBlock(fixedKeys.passwordCheckKey, CHECK_NONCE);
    expect(block).toHaveLength(DATA_TRANSFER_PASSWORD_CHECK_BLOCK_BYTES);
    expect(block.toString("hex")).toBe(PASSWORD_CHECK_VECTOR);
    expect(verifyPasswordCheckBlock(fixedKeys.passwordCheckKey, block)).toBe(true);
  });

  test("password verifier rejects wrong keys, tampering, and truncation identically", () => {
    const block = createPasswordCheckBlock(fixedKeys.passwordCheckKey, CHECK_NONCE);
    const tampered = Buffer.from(block);
    tampered.writeUInt8(tampered.readUInt8(12) ^ 1, 12);
    const wrongKey = Buffer.alloc(32, 0xff);
    expect(verifyPasswordCheckBlock(wrongKey, block)).toBe(false);
    expect(verifyPasswordCheckBlock(fixedKeys.passwordCheckKey, tampered)).toBe(false);
    expect(verifyPasswordCheckBlock(fixedKeys.passwordCheckKey, block.subarray(0, -1))).toBe(false);
  });

  test("does not modify verifier inputs", () => {
    const key = Buffer.from(fixedKeys.passwordCheckKey);
    const keyBefore = Buffer.from(key);
    const nonce = Buffer.from(CHECK_NONCE);
    const nonceBefore = Buffer.from(nonce);
    createPasswordCheckBlock(key, nonce);
    expect(key).toEqual(keyBefore);
    expect(nonce).toEqual(nonceBefore);
  });

  test("computes and verifies the fixed public-header HMAC vector", () => {
    const unsigned = headerWith(validHeader.passwordCheckHex);
    const mac = computePublicHeaderMac(fixedKeys.headerAuthKey, unsigned);
    expect(mac.toString("hex")).toBe(HEADER_MAC_VECTOR);
    expect(verifyPublicHeaderMac(fixedKeys.headerAuthKey, validHeader)).toBe(true);
    const tampered = { ...validHeader, passwordHint: "tampered" };
    expect(verifyPublicHeaderMac(fixedKeys.headerAuthKey, tampered)).toBe(false);
    expect(
      verifyPublicHeaderMac(fixedKeys.headerAuthKey, { ...validHeader, headerMacHex: "00" }),
    ).toBe(false);
  });

  test("verifies a complete header and returns live derived keys", async () => {
    const keys = await verifyPassword(FIXED_PASSWORD, validHeader);
    try {
      expect(keys.payloadKey).toEqual(fixedKeys.payloadKey);
      expect(keys.payloadKey.some((byte) => byte !== 0)).toBe(true);
    } finally {
      keys.destroy();
    }
  });

  test("maps wrong password, verifier damage, and header-MAC damage to the same public error", async () => {
    const damagedVerifier = Buffer.from(validHeader.passwordCheckHex, "hex");
    damagedVerifier.writeUInt8(damagedVerifier.readUInt8(20) ^ 1, 20);
    const cases: Array<[string, () => Promise<DerivedPackageKeys>]> = [
      ["wrong password", () => verifyPassword("wrong password phrase", validHeader)],
      [
        "damaged verifier",
        () =>
          verifyPassword(FIXED_PASSWORD, {
            ...validHeader,
            passwordCheckHex: damagedVerifier.toString("hex"),
          }),
      ],
      [
        "damaged header MAC",
        () => verifyPassword(FIXED_PASSWORD, { ...validHeader, headerMacHex: "ff".repeat(32) }),
      ],
    ];
    const presentations = [];
    for (const [, operation] of cases) {
      const error = await operation().then(
        () => undefined,
        (failure: unknown) => failure,
      );
      presentations.push(expectStableCryptoError(error, "PASSWORD_OR_PACKAGE_INVALID"));
    }
    expect(new Set(presentations.map((value) => JSON.stringify(value)))).toHaveLength(1);
  });

  test("propagates a non-authentication decipher.final system error unchanged", async () => {
    const systemError = new Error("unique simulated decipher system failure");
    const probe = createDecipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12));
    const prototype = Object.getPrototypeOf(probe) as { final(): Buffer };
    const final = vi.spyOn(prototype, "final").mockImplementationOnce(() => {
      throw systemError;
    });
    try {
      await expect(verifyPassword(FIXED_PASSWORD, validHeader)).rejects.toBe(systemError);
    } finally {
      final.mockRestore();
    }
  });

  test("maps malformed runtime headers to the password/package error", async () => {
    const malformed = { ...validHeader, saltHex: "not-a-salt" };
    const error = await verifyPassword(FIXED_PASSWORD, malformed as DataTransferPublicHeader).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expectStableCryptoError(error, "PASSWORD_OR_PACKAGE_INVALID");
  });

  test.each(["123E4567-E89B-42D3-A456-426614174000", "00000000-0000-0000-0000-000000000000"])(
    "rejects a signed public header whose package ID is not canonical: %s",
    async (packageId) => {
      const unsigned = { ...validHeader, packageId, headerMacHex: "00".repeat(32) };
      const header = {
        ...unsigned,
        headerMacHex: computePublicHeaderMac(fixedKeys.headerAuthKey, unsigned).toString("hex"),
      };
      const result = await verifyPassword(FIXED_PASSWORD, header).then(
        (keys) => {
          keys.destroy();
          return "accepted";
        },
        (error: unknown) => error,
      );
      expectStableCryptoError(result, "PASSWORD_OR_PACKAGE_INVALID");
    },
  );

  test("destroys derived keys when complete password verification fails", async () => {
    const destroy = vi.spyOn(DerivedPackageKeys.prototype, "destroy");
    try {
      await expect(
        verifyPassword(FIXED_PASSWORD, { ...validHeader, headerMacHex: "ff".repeat(32) }),
      ).rejects.toMatchObject({ code: "PASSWORD_OR_PACKAGE_INVALID" });
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      destroy.mockRestore();
    }
  });
});

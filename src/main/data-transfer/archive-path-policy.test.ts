import { describe, expect, test } from "vitest";
import {
  ArchivePathPolicy,
  ArchivePolicyError,
  assertArchiveLogicalPathsUnique,
  assertPublicHeaderWithinArchiveLimit,
  assertSafeExtractionTargetMetadata,
  checkedAddArchiveBytes,
  claimArchiveResourceUsage,
  DATA_TRANSFER_ARCHIVE_LIMITS,
} from "./archive-path-policy.js";

const DATABASE_PATH = "library/library.sqlite3";
const SETTINGS_PATH = "portable-settings.json";
const ASSET_PATH = `library/assets/${"A".repeat(64)}.asset`;

function expectPolicyError(
  operation: () => unknown,
  reason?: InstanceType<typeof ArchivePolicyError>["reason"],
): ArchivePolicyError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchivePolicyError);
    expect(error).toMatchObject({
      code: "PACKAGE_TAMPERED",
      ...(reason ? { reason } : {}),
    });
    return error as ArchivePolicyError;
  }
  throw new Error("Expected archive policy error");
}

describe("archive resource limits", () => {
  test("exports the fixed immutable limits", () => {
    expect(DATA_TRANSFER_ARCHIVE_LIMITS).toEqual({
      publicHeaderBytes: 64 * 1024,
      logicalPathBytes: 1024,
      entryCount: 1_000_000,
      entryUncompressedBytes: 64 * 1024 ** 3,
      totalUncompressedBytes: 16 * 1024 ** 4,
      maximumCompressionRatio: 200,
    });
    expect(Object.isFrozen(DATA_TRANSFER_ARCHIVE_LIMITS)).toBe(true);
  });

  test("accepts the public-header limit and rejects one byte more", () => {
    expect(assertPublicHeaderWithinArchiveLimit(64 * 1024)).toBe(64 * 1024);
    expectPolicyError(
      () => assertPublicHeaderWithinArchiveLimit(64 * 1024 + 1),
      "public-header-too-large",
    );
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid numeric resource value %s",
    (value) => {
      expectPolicyError(() => assertPublicHeaderWithinArchiveLimit(value), "invalid-resource-size");
      expectPolicyError(
        () => checkedAddArchiveBytes(0, value, Number.MAX_SAFE_INTEGER),
        "invalid-resource-size",
      );
      expectPolicyError(
        () => new ArchivePathPolicy().claim(DATABASE_PATH, value, 0),
        "invalid-resource-size",
      );
      expectPolicyError(
        () => new ArchivePathPolicy().claim(DATABASE_PATH, 0, value),
        "invalid-resource-size",
      );
    },
  );

  test("checks safe-integer overflow before adding", () => {
    expect(checkedAddArchiveBytes(Number.MAX_SAFE_INTEGER - 1, 1, Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expectPolicyError(
      () => checkedAddArchiveBytes(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      "resource-budget-exceeded",
    );
  });

  test("enforces entry-count and total-size boundaries without post-add overflow", () => {
    expect(
      claimArchiveResourceUsage(
        {
          entryCount: DATA_TRANSFER_ARCHIVE_LIMITS.entryCount - 1,
          totalUncompressedBytes: DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes,
        },
        0,
        0,
      ),
    ).toEqual({
      entryCount: DATA_TRANSFER_ARCHIVE_LIMITS.entryCount,
      totalUncompressedBytes: DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes,
    });

    expectPolicyError(
      () =>
        claimArchiveResourceUsage(
          {
            entryCount: DATA_TRANSFER_ARCHIVE_LIMITS.entryCount,
            totalUncompressedBytes: 0,
          },
          0,
          0,
        ),
      "entry-count-exceeded",
    );
    expectPolicyError(
      () =>
        claimArchiveResourceUsage(
          {
            entryCount: 0,
            totalUncompressedBytes: DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes,
          },
          1,
          1,
        ),
      "total-uncompressed-size-exceeded",
    );
  });

  test("enforces the per-entry uncompressed boundary", () => {
    const policy = new ArchivePathPolicy();
    policy.claim(
      DATABASE_PATH,
      DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes,
      DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes,
    );
    expect(policy.usage.totalUncompressedBytes).toBe(
      DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes,
    );

    expectPolicyError(
      () =>
        new ArchivePathPolicy().claim(
          DATABASE_PATH,
          DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes + 1,
          DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes + 1,
        ),
      "entry-uncompressed-size-exceeded",
    );
  });
});

describe("logical path policy", () => {
  test.each([
    DATABASE_PATH,
    ASSET_PATH,
    "legacy-drafts/123e4567-e89b-42d3-a456-426614174000/draft.json",
    "legacy-drafts/123e4567-e89b-42d3-a456-426614174000/20260816-235959.patdoc",
    SETTINGS_PATH,
    "verification/integrity-summary.json",
  ])("claims exact Task 3 allowlisted path %s", (logicalPath) => {
    const policy = new ArchivePathPolicy();
    expect(policy.claim(logicalPath, 1, 1)).toEqual({ entryCount: 1, totalUncompressedBytes: 1 });
  });

  test.each([
    "",
    "../escape",
    "/absolute",
    "//server/share",
    "C:/absolute",
    "C:\\absolute",
    "\\\\server\\share",
    "library\\library.sqlite3",
    "library/assets/name:stream",
    "library/assets/name\0.asset",
    "library/assets/name\u001f.asset",
    "library//library.sqlite3",
    "library/./library.sqlite3",
    "library/assets/a/../../b",
    "library/library.sqlite3.",
    "library/library.sqlite3 ",
    "library/assets/CON.asset",
    "library/assets/con.asset",
    "library/assets/CON.txt.asset",
    "library/assets/COM1.asset",
    "library/assets/Lpt9.asset",
    "library/assets/name?.asset",
    `library/assets/${"a".repeat(64)}.asset`,
    "LIBRARY/library.sqlite3",
    "unknown/file.bin",
  ])("rejects unsafe or non-allowlisted logical path %s", (logicalPath) => {
    const error = expectPolicyError(() => new ArchivePathPolicy().claim(logicalPath, 1, 1));
    if (logicalPath.length > 0) expect(error.message).not.toContain(logicalPath);
  });

  test("rejects paths over 1024 UTF-8 bytes", () => {
    const logicalPath = `library/assets/${"专".repeat(342)}.asset`;
    expect(new TextEncoder().encode(logicalPath).byteLength).toBeGreaterThan(1024);
    expectPolicyError(
      () => new ArchivePathPolicy().claim(logicalPath, 1, 1),
      "logical-path-too-long",
    );
  });

  test("rejects exact and ASCII case-fold duplicates", () => {
    const exactPolicy = new ArchivePathPolicy();
    exactPolicy.claim(DATABASE_PATH, 1, 1);
    expectPolicyError(() => exactPolicy.claim(DATABASE_PATH, 1, 1), "duplicate-logical-path");

    const casePolicy = new ArchivePathPolicy();
    casePolicy.claim(DATABASE_PATH, 1, 1);
    expectPolicyError(
      () => casePolicy.claim("LIBRARY/library.sqlite3", 1, 1),
      "duplicate-case-folded-logical-path",
    );
  });

  test.each([
    ["folder/Σ.asset", "folder/ς.asset"],
    ["folder/ß.asset", "folder/SS.asset"],
    ["folder/ẞ.asset", "folder/ß.asset"],
    ["folder/ẞ.asset", "folder/SS.asset"],
    ["folder/ﬀ.asset", "folder/FF.asset"],
  ])("rejects Unicode case-fold-equivalent duplicates %s and %s", (first, second) => {
    expectPolicyError(
      () => assertArchiveLogicalPathsUnique([first, second]),
      "duplicate-case-folded-logical-path",
    );
  });

  test("rejects Unicode NFC and combined NFC/case-fold duplicates without normalizing input", () => {
    expectPolicyError(
      () => assertArchiveLogicalPathsUnique(["folder/é.asset", "folder/e\u0301.asset"]),
      "duplicate-nfc-logical-path",
    );
    expectPolicyError(
      () => assertArchiveLogicalPathsUnique(["folder/É.asset", "folder/e\u0301.asset"]),
      "duplicate-nfc-case-folded-logical-path",
    );
    expectPolicyError(
      () => new ArchivePathPolicy().claim("folder/e\u0301.asset", 1, 1),
      "logical-path-not-nfc",
    );
  });
});

describe("archive claim accounting", () => {
  test("allows 0/0 and the exact 200:1 compression-ratio boundary", () => {
    const policy = new ArchivePathPolicy();
    policy.claim(DATABASE_PATH, 0, 0);
    policy.claim(SETTINGS_PATH, 1, 200);
    expect(policy.usage).toEqual({ entryCount: 2, totalUncompressedBytes: 200 });
  });

  test("rejects zero compressed bytes for non-empty data and ratios above 200:1", () => {
    expectPolicyError(
      () => new ArchivePathPolicy().claim(DATABASE_PATH, 0, 1),
      "compression-ratio-exceeded",
    );
    expectPolicyError(
      () => new ArchivePathPolicy().claim(DATABASE_PATH, 1, 201),
      "compression-ratio-exceeded",
    );
  });

  test("does not pollute path or resource state when a claim fails", () => {
    const policy = new ArchivePathPolicy();
    policy.claim(DATABASE_PATH, 2, 200);
    const beforeFailure = policy.usage;

    expectPolicyError(
      () => policy.claim(SETTINGS_PATH, 1, DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes + 1),
      "entry-uncompressed-size-exceeded",
    );
    expect(policy.usage).toEqual(beforeFailure);
    expect(policy.claim(SETTINGS_PATH, 1, 1)).toEqual({
      entryCount: 2,
      totalUncompressedBytes: 201,
    });
  });
});

describe("extraction target metadata", () => {
  test.each(["missing", "regular-file", "directory"] as const)(
    "accepts externally classified safe target metadata %s",
    (classification) => {
      expect(assertSafeExtractionTargetMetadata({ classification })).toEqual({ classification });
    },
  );

  test.each(["symbolic-link", "junction", "directory-link", "reparse-point"] as const)(
    "rejects externally classified %s targets",
    (classification) => {
      expectPolicyError(
        () => assertSafeExtractionTargetMetadata({ classification }),
        "unsafe-extraction-target-metadata",
      );
    },
  );

  test.each([
    { classification: "other" },
    { classification: "regular-file", reparseTag: 1 },
    { classification: "unknown" },
    null,
  ])("fails closed for invalid external stat classification %#", (metadata) => {
    expectPolicyError(
      () => assertSafeExtractionTargetMetadata(metadata),
      "unsafe-extraction-target-metadata",
    );
  });

  test("accepts a strict null-prototype data record", () => {
    const metadata = Object.assign(Object.create(null) as object, {
      classification: "regular-file",
    });
    expect(assertSafeExtractionTargetMetadata(metadata)).toEqual({
      classification: "regular-file",
    });
  });

  test("rejects custom prototypes, symbols, and non-enumerable properties", () => {
    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    customPrototype.classification = "regular-file";
    expectPolicyError(
      () => assertSafeExtractionTargetMetadata(customPrototype),
      "unsafe-extraction-target-metadata",
    );

    const withSymbol = { classification: "regular-file", [Symbol("hidden")]: "secret" };
    expectPolicyError(
      () => assertSafeExtractionTargetMetadata(withSymbol),
      "unsafe-extraction-target-metadata",
    );

    const withNonEnumerableExtra = { classification: "regular-file" };
    Object.defineProperty(withNonEnumerableExtra, "hidden", {
      value: "secret",
      enumerable: false,
    });
    expectPolicyError(
      () => assertSafeExtractionTargetMetadata(withNonEnumerableExtra),
      "unsafe-extraction-target-metadata",
    );

    const nonEnumerableClassification = {};
    Object.defineProperty(nonEnumerableClassification, "classification", {
      value: "regular-file",
      enumerable: false,
    });
    expectPolicyError(
      () => assertSafeExtractionTargetMetadata(nonEnumerableClassification),
      "unsafe-extraction-target-metadata",
    );
  });

  test("rejects a classification accessor without executing it", () => {
    let getterCalls = 0;
    const metadata = Object.defineProperty({}, "classification", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "regular-file";
      },
    });

    expectPolicyError(
      () => assertSafeExtractionTargetMetadata(metadata),
      "unsafe-extraction-target-metadata",
    );
    expect(getterCalls).toBe(0);
  });

  test("does not execute or expose a throwing classification getter", () => {
    let getterCalls = 0;
    const sensitiveMessage = "sensitive patent path from getter";
    const metadata = Object.defineProperty({}, "classification", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(sensitiveMessage);
      },
    });

    const error = expectPolicyError(
      () => assertSafeExtractionTargetMetadata(metadata),
      "unsafe-extraction-target-metadata",
    );
    expect(getterCalls).toBe(0);
    expect(error.message).not.toContain(sensitiveMessage);
  });

  test.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const)(
    "converts a throwing Proxy %s trap to a fixed policy error",
    (trap) => {
      const sensitiveMessage = `sensitive patent path from ${trap}`;
      const handler: ProxyHandler<{ classification: string }> = {
        [trap]() {
          throw new Error(sensitiveMessage);
        },
      };
      const metadata = new Proxy({ classification: "regular-file" }, handler);

      const error = expectPolicyError(
        () => assertSafeExtractionTargetMetadata(metadata),
        "unsafe-extraction-target-metadata",
      );
      expect(error.message).not.toContain(sensitiveMessage);
    },
  );

  test("rejects a Proxy with legal reflection results before invoking any trap", () => {
    const trapCalls = {
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
    };
    const metadata = new Proxy(
      { classification: "regular-file" },
      {
        getPrototypeOf() {
          trapCalls.getPrototypeOf += 1;
          return Object.prototype;
        },
        ownKeys() {
          trapCalls.ownKeys += 1;
          return ["classification"];
        },
        getOwnPropertyDescriptor() {
          trapCalls.getOwnPropertyDescriptor += 1;
          return {
            value: "regular-file",
            writable: true,
            enumerable: true,
            configurable: true,
          };
        },
      },
    );

    expectPolicyError(
      () => assertSafeExtractionTargetMetadata(metadata),
      "unsafe-extraction-target-metadata",
    );
    expect(trapCalls).toEqual({
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
    });
  });

  test("rejects a throwing Proxy before invoking any trap or exposing its message", () => {
    const trapCalls = {
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
    };
    const sensitiveMessage = "sensitive patent path from rejected proxy";
    const metadata = new Proxy(
      { classification: "regular-file" },
      {
        getPrototypeOf() {
          trapCalls.getPrototypeOf += 1;
          throw new Error(sensitiveMessage);
        },
        ownKeys() {
          trapCalls.ownKeys += 1;
          throw new Error(sensitiveMessage);
        },
        getOwnPropertyDescriptor() {
          trapCalls.getOwnPropertyDescriptor += 1;
          throw new Error(sensitiveMessage);
        },
      },
    );

    const error = expectPolicyError(
      () => assertSafeExtractionTargetMetadata(metadata),
      "unsafe-extraction-target-metadata",
    );
    expect(trapCalls).toEqual({
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
    });
    expect(error.message).not.toContain(sensitiveMessage);
  });
});

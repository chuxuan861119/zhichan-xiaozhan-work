import { describe, expect, test } from "vitest";
import {
  APP_ERROR_PRESENTATIONS,
  type AppError,
  AppErrorCodeSchema,
  AppErrorSchema,
  DataTransferOperationKindSchema,
  normalizeAppError,
} from "./result.js";

const DATA_TRANSFER_ERROR_CODES = [
  "LIBRARY_NOT_EMPTY",
  "PASSWORD_OR_PACKAGE_INVALID",
  "PACKAGE_TOO_NEW",
  "PACKAGE_INCOMPLETE",
  "PACKAGE_TAMPERED",
  "INSUFFICIENT_SPACE",
  "WINDOWS_KEY_PROTECTION_UNAVAILABLE",
  "SOURCE_SAVE_FAILED",
  "DESTINATION_UNAVAILABLE",
  "IMPORT_ROLLED_BACK",
  "IMPORT_RECOVERY_REQUIRED",
] as const;

test("keeps a clear recognized-only import message after error normalization", () => {
  expect(normalizeAppError({ code: "DOCX_UNRECOGNIZED", message: "raw" }).message).toContain(
    "无法识别的内容，不能导入",
  );
  expect(normalizeAppError({ code: "DOCX_DUPLICATE_BOOK", message: "raw" }).message).toContain(
    "重复的五书类型",
  );
});

describe("data transfer error presentations", () => {
  test.each(["full-data-export", "full-data-import", "library-swap"] as const)(
    "accepts the finite data transfer operation kind %s",
    (operationKind) => {
      expect(DataTransferOperationKindSchema.parse(operationKind)).toBe(operationKind);
      expect(
        AppErrorSchema.parse({
          code: "OPERATION_IN_PROGRESS",
          message: "safe",
          operationKind,
        }).operationKind,
      ).toBe(operationKind);
    },
  );

  test.each([
    "arbitrary-operation",
    "D:\\客户资料\\绝密专利.patdoc",
    "绝密专利标题",
    "Error: failed at transfer.ts:42:7",
  ])("rejects unsafe operation kind content: %s", (operationKind) => {
    expect(DataTransferOperationKindSchema.safeParse(operationKind).success).toBe(false);
    expect(
      AppErrorSchema.safeParse({
        code: "OPERATION_IN_PROGRESS",
        message: "safe",
        operationKind,
      }).success,
    ).toBe(false);
  });

  test("normalizes only allowed operation kinds without exposing raw details", () => {
    const rawMessage =
      "path=D:\\客户资料\\绝密专利.patdoc; patent=绝密专利标题; stack=transfer.ts:42:7";
    const normalized = normalizeAppError({
      code: "OPERATION_IN_PROGRESS",
      message: rawMessage,
      operationKind: "full-data-import",
    });

    expect(normalized).toEqual({
      code: "OPERATION_IN_PROGRESS",
      message: APP_ERROR_PRESENTATIONS.OPERATION_IN_PROGRESS.message,
      nextAction: APP_ERROR_PRESENTATIONS.OPERATION_IN_PROGRESS.nextAction,
      operationKind: "full-data-import",
    });
    expect(JSON.stringify(normalized)).not.toContain(rawMessage);
    expect(JSON.stringify(normalized)).not.toContain("绝密专利标题");
    expect(JSON.stringify(normalized)).not.toContain("transfer.ts");

    const invalidRuntimeValue = normalizeAppError({
      code: "OPERATION_IN_PROGRESS",
      message: rawMessage,
      operationKind: "D:\\客户资料\\绝密专利.patdoc",
    } as unknown as AppError);
    expect(invalidRuntimeValue.operationKind).toBeUndefined();
  });

  test.each(DATA_TRANSFER_ERROR_CODES)("defines a complete presentation for %s", (code) => {
    expect(AppErrorCodeSchema.safeParse(code).success).toBe(true);

    const presentation = APP_ERROR_PRESENTATIONS[code];
    expect(presentation.message.trim().length).toBeGreaterThan(0);
    expect(presentation.nextAction.trim().length).toBeGreaterThan(0);
  });

  test.each(DATA_TRANSFER_ERROR_CODES)(
    "normalizes sensitive raw details at the real boundary for %s",
    (code) => {
      const rawDetails = [
        "password=test-password-123",
        "patent=绝密专利标题",
        "path=D:\\客户资料\\绝密专利.patdoc",
        "unc=\\\\fileserver\\private\\完整数据包.patbackup",
        "sql=SELECT * FROM patents WHERE title='绝密专利标题'",
        "stack=Error: decrypt failed at importPackage (transfer.ts:42:7)",
      ];
      const normalized = normalizeAppError({
        code,
        message: rawDetails.join("; "),
        nextAction: `debug: ${rawDetails.join(" | ")}`,
      });
      const presentation = APP_ERROR_PRESENTATIONS[code];

      expect(normalized.message).toBe(presentation.message);
      expect(normalized.nextAction).toBe(presentation.nextAction);

      const serialized = JSON.stringify({
        message: normalized.message,
        nextAction: normalized.nextAction,
      });
      for (const detail of rawDetails) expect(serialized).not.toContain(detail);
      expect(serialized).not.toContain("test-password-123");
      expect(serialized).not.toContain("绝密专利标题");
      expect(serialized).not.toContain("D:\\客户资料\\绝密专利.patdoc");
      expect(serialized).not.toContain("\\\\fileserver\\private");
      expect(serialized).not.toContain("SELECT * FROM patents");
      expect(serialized).not.toContain("transfer.ts:42:7");
    },
  );
});

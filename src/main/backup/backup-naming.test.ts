import { describe, expect, test } from "vitest";
import { backupRelativeName, managedBackupIdentity } from "./backup-naming.js";

const info = {
  documentType: "patent" as const,
  documentId: "00000000-0000-4000-8000-000000000001",
  displayName: "电池冷却机构",
  revision: 108,
  modifiedAt: "2026-09-11T04:38:00.000Z",
  createdAt: "2026-07-02T03:00:00.000Z",
  patentType: "invention" as const,
  customer: "甲公司",
};
describe("backup names", () => {
  test("uses creation month, local backup minute, type, title and optional customer", () => {
    const name = backupRelativeName(info, new Date(2026, 8, 11, 12, 38), "12345678");
    expect(name).toMatch(/^2026-07\/2026-09-11_12-38_发明_电池冷却机构_甲公司_PWB2-PAT-/);
    expect(name).toContain("-r108-12345678.patdoc");
    expect(managedBackupIdentity(name, info)).toBe(true);
    expect(managedBackupIdentity(name, { ...info, documentId: "different" })).toBe(false);
    expect(backupRelativeName({ ...info, customer: null }, new Date(), "12345678")).not.toContain(
      "甲公司",
    );
  });
  test("sanitizes filenames and keeps unknown creation dates in the legacy root layout", () => {
    const name = backupRelativeName(
      { ...info, displayName: '../A:B/*?"<>|'.repeat(40) },
      new Date(),
      "12345678",
    );
    expect(name.length).toBeLessThan(240);
    expect(name.split("/")).toHaveLength(2);
    expect(name).not.toContain("..");
    const legacy = backupRelativeName({ ...info, createdAt: undefined }, new Date(), "12345678");
    expect(legacy.startsWith("PWB-AUTO-PAT-")).toBe(true);
    expect(managedBackupIdentity(legacy, info)).toBe(true);
  });
});

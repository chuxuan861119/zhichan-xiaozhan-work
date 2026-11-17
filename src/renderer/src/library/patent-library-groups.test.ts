import { expect, test } from "vitest";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { buildPatentLibraryGroups } from "./patent-library-groups";

function patent(
  patentId: string,
  createdAt: string,
  modifiedAt = "2026-08-20T12:00:00.000+08:00",
): LibraryPatentSummary {
  return {
    patentId,
    name: patentId,
    customer: null,
    patentType: "invention",
    revision: 0,
    bookStatuses: {
      claims: "draft",
      description: "draft",
      "description-drawings": "empty",
      abstract: "draft",
      "abstract-drawing": "empty",
    },
    issueCount: 0,
    saveState: "saved",
    createdAt,
    modifiedAt,
    deletedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
}

const now = new Date("2026-08-20T12:00:00.000+08:00");

test("groups by local creation month and orders months and patents by creation time", () => {
  const augustEarly = patent(
    "00000000-0000-4000-8000-000000000101",
    "2026-08-03T10:00:00.000+08:00",
    "2026-08-19T10:00:00.000+08:00",
  );
  const augustLateButOldEdit = patent(
    "00000000-0000-4000-8000-000000000102",
    "2026-08-18T10:00:00.000+08:00",
    "2026-08-04T10:00:00.000+08:00",
  );
  const july = patent("00000000-0000-4000-8000-000000000103", "2026-07-18T10:00:00.000+08:00");
  const june = patent("00000000-0000-4000-8000-000000000104", "2026-06-18T10:00:00.000+08:00");
  const december = patent("00000000-0000-4000-8000-000000000105", "2025-12-18T10:00:00.000+08:00");

  const groups = buildPatentLibraryGroups(
    [july, augustEarly, december, augustLateButOldEdit, june],
    now,
    false,
  );

  expect(groups.map((group) => [group.key, group.label, group.defaultExpanded])).toEqual([
    ["2026-08", "2026年8月", true],
    ["2026-07", "2026年7月", true],
    ["2026-06", "2026年6月", false],
    ["2025-12", "2025年12月", false],
  ]);
  expect(groups[0]?.patents.map((item) => item.patentId)).toEqual([
    augustLateButOldEdit.patentId,
    augustEarly.patentId,
  ]);
});

test("uses the previous December as the second default-open month in January", () => {
  const groups = buildPatentLibraryGroups(
    [
      patent("00000000-0000-4000-8000-000000000201", "2026-01-03T10:00:00.000+08:00"),
      patent("00000000-0000-4000-8000-000000000202", "2025-12-31T10:00:00.000+08:00"),
      patent("00000000-0000-4000-8000-000000000203", "2025-11-30T10:00:00.000+08:00"),
    ],
    new Date("2026-01-02T12:00:00.000+08:00"),
    false,
  );

  expect(groups.map((group) => [group.key, group.defaultExpanded])).toEqual([
    ["2026-01", true],
    ["2025-12", true],
    ["2025-11", false],
  ]);
});

test("forces matching months open while search or type filtering is active", () => {
  const groups = buildPatentLibraryGroups(
    [
      patent("00000000-0000-4000-8000-000000000301", "2026-06-03T10:00:00.000+08:00"),
      patent("00000000-0000-4000-8000-000000000302", "2025-12-03T10:00:00.000+08:00"),
    ],
    now,
    true,
  );

  expect(groups.every((group) => group.defaultExpanded)).toBe(true);
});

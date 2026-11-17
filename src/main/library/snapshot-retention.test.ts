import {
  retainedSnapshotRevisions,
  type SnapshotRetentionCandidate,
} from "./snapshot-retention.js";

function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): string {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

function candidate(revision: number, createdAt: string): SnapshotRetentionCandidate {
  return { revision, createdAt };
}

function revisionsOf(candidates: readonly SnapshotRetentionCandidate[], now: Date): number[] {
  return [...retainedSnapshotRevisions(candidates, now)].sort((left, right) => left - right);
}

describe("retainedSnapshotRevisions", () => {
  const now = new Date(2026, 7, 16, 12, 0, 0);

  test("retains every snapshot from the last hour", () => {
    const rows = [
      candidate(1, new Date(now.getTime() - 60 * 60 * 1000).toISOString()),
      candidate(2, new Date(now.getTime() - 30 * 60 * 1000).toISOString()),
      candidate(3, new Date(now.getTime() - 5 * 60 * 1000).toISOString()),
    ];

    expect(revisionsOf(rows, now)).toEqual([1, 2, 3]);
  });

  test("keeps the two newest snapshots from each old local-calendar bucket", () => {
    const rows = [
      candidate(1, localDate(2026, 8, 16, 10, 1)),
      candidate(2, localDate(2026, 8, 16, 10, 20)),
      candidate(3, localDate(2026, 8, 16, 10, 40)),
      candidate(4, localDate(2026, 8, 16, 9, 10)),
      candidate(5, localDate(2026, 8, 16, 9, 40)),
      candidate(6, localDate(2026, 8, 15, 12, 1)),
      candidate(7, localDate(2026, 8, 15, 12, 20)),
      candidate(8, localDate(2026, 8, 15, 12, 40)),
      candidate(9, localDate(2026, 8, 1, 12, 0)),
      candidate(10, localDate(2026, 7, 1, 12, 0)),
      candidate(11, localDate(2025, 8, 1, 12, 0)),
    ];

    expect(revisionsOf(rows, now)).toEqual([2, 3, 4, 5, 7, 8, 9, 10, 11]);
  });

  test("keeps zero, one, and two candidate buckets unchanged", () => {
    const rows = [
      candidate(1, localDate(2026, 8, 16, 10, 1)),
      candidate(2, localDate(2026, 8, 16, 9, 10)),
      candidate(3, localDate(2026, 8, 16, 9, 40)),
      candidate(4, localDate(2026, 8, 15, 12, 1)),
    ];

    expect(revisionsOf(rows, now)).toEqual([1, 2, 3, 4]);
  });

  test("groups snapshots older than a week and newer than a clamped month by local Monday week", () => {
    const rows = [
      candidate(1, localDate(2026, 8, 3, 0, 1)),
      candidate(2, localDate(2026, 8, 5, 8)),
      candidate(3, localDate(2026, 8, 7, 16)),
      candidate(4, localDate(2026, 8, 8, 23, 59)),
    ];

    expect(revisionsOf(rows, now)).toEqual([3, 4]);
  });

  test("drops an older snapshot instead of the newest one inside a day bucket", () => {
    const rows = [
      candidate(104, localDate(2026, 8, 13, 9, 0)),
      candidate(133, localDate(2026, 8, 13, 16, 26)),
      candidate(141, localDate(2026, 8, 13, 16, 55)),
    ];

    expect(revisionsOf(rows, now)).toEqual([133, 141]);
  });

  test("prefers the newest timestamp and the newer revision on ties, never duplicating a choice", () => {
    const rows = [
      candidate(10, localDate(2026, 8, 15, 12, 10)),
      candidate(11, localDate(2026, 8, 15, 12, 30)),
      candidate(12, localDate(2026, 8, 15, 12, 50)),
      candidate(13, localDate(2026, 8, 15, 12, 30)),
    ];

    expect(revisionsOf(rows, now)).toEqual([12, 13]);
  });

  test("is stable for reversed input and does not mutate the caller array", () => {
    const rows = [
      candidate(1, localDate(2026, 8, 15, 12, 1)),
      candidate(2, localDate(2026, 8, 15, 12, 20)),
      candidate(3, localDate(2026, 8, 15, 12, 40)),
    ];
    const original = rows.slice();

    expect(revisionsOf(rows, now)).toEqual(revisionsOf([...rows].reverse(), now));
    expect(rows).toEqual(original);
  });

  test("uses local week, month, and year boundaries around calendar edges", () => {
    const boundaryNow = new Date(2026, 2, 1, 0, 30, 0);
    const rows = [
      candidate(1, localDate(2026, 2, 1, 0, 0)),
      candidate(2, localDate(2026, 1, 31, 23, 59)),
      candidate(3, localDate(2026, 1, 26, 12, 0)),
      candidate(4, localDate(2026, 1, 1, 12, 0)),
      candidate(5, localDate(2025, 12, 31, 12, 0)),
      candidate(6, localDate(2025, 3, 1, 12, 0)),
    ];

    expect(revisionsOf(rows, boundaryNow)).toEqual([1, 2, 3, 5, 6]);
  });

  test("does not use an absent source field to influence selection", () => {
    const rows = [
      candidate(1, localDate(2026, 8, 15, 12, 1)),
      candidate(2, localDate(2026, 8, 15, 12, 20)),
      candidate(3, localDate(2026, 8, 15, 12, 40)),
    ];

    expect(revisionsOf(rows, now)).toEqual([2, 3]);
  });
});

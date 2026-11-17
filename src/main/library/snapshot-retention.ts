export type SnapshotRetentionCandidate = Readonly<{
  revision: number;
  createdAt: string;
}>;

type RetentionTier = "hour" | "day" | "week" | "month" | "year";

type Bucket = Readonly<{
  key: string;
  start: Date;
  end: Date;
}>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function subtractClampedMonths(date: Date, count: number): Date {
  const targetMonth = new Date(date.getFullYear(), date.getMonth() - count, 1);
  const lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
  return new Date(
    targetMonth.getFullYear(),
    targetMonth.getMonth(),
    Math.min(date.getDate(), lastDay),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function subtractClampedYears(date: Date, count: number): Date {
  const targetYear = date.getFullYear() - count;
  const lastDay = new Date(targetYear, date.getMonth() + 1, 0).getDate();
  return new Date(
    targetYear,
    date.getMonth(),
    Math.min(date.getDate(), lastDay),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function bucketFor(tier: RetentionTier, date: Date): Bucket {
  switch (tier) {
    case "hour": {
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
      const end = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate(),
        start.getHours() + 1,
      );
      return { key: `hour:${start.getTime()}`, start, end };
    }
    case "day": {
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      return { key: `day:${start.getTime()}`, start, end };
    }
    case "week": {
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const daysSinceMonday = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - daysSinceMonday);
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
      return { key: `week:${start.getTime()}`, start, end };
    }
    case "month": {
      const start = new Date(date.getFullYear(), date.getMonth(), 1);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      return { key: `month:${start.getTime()}`, start, end };
    }
    case "year": {
      const start = new Date(date.getFullYear(), 0, 1);
      const end = new Date(start.getFullYear() + 1, 0, 1);
      return { key: `year:${start.getTime()}`, start, end };
    }
  }
}

/**
 * Keeps the newest snapshots of a bucket.
 *
 * Sampling the bucket by clock position used to pick whichever snapshot sat closest to a point
 * one or two thirds in, which drops the newest snapshot whenever an older one lands closer to the
 * sample point. That is the wrong end: the newest snapshot is where the edit journal is replayed
 * from, and losing it while the older ones survive is precisely what left a patent with no
 * snapshot able to reach its live revision. The retained revisions are returned newest-last, so
 * the selection stays monotonic in revision.
 */
function chooseBucketCandidates(
  rows: readonly SnapshotRetentionCandidate[],
): SnapshotRetentionCandidate[] {
  if (rows.length <= 2) return [...rows];
  return [...rows]
    .sort((left, right) => {
      const byTime = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      return byTime !== 0 ? byTime : left.revision - right.revision;
    })
    .slice(-2);
}

export function retainedSnapshotRevisions(
  candidates: readonly SnapshotRetentionCandidate[],
  now: Date,
): ReadonlySet<number> {
  const nowMs = now.getTime();
  const hourAgo = nowMs - HOUR_MS;
  const dayAgo = nowMs - DAY_MS;
  const weekAgo = nowMs - WEEK_MS;
  const monthAgo = subtractClampedMonths(now, 1).getTime();
  const yearAgo = subtractClampedYears(now, 1).getTime();
  const recent = new Set<number>();
  const buckets = new Map<string, { bucket: Bucket; rows: SnapshotRetentionCandidate[] }>();

  for (const candidate of candidates) {
    const createdAt = new Date(candidate.createdAt);
    const timestamp = createdAt.getTime();
    if (timestamp >= hourAgo) {
      recent.add(candidate.revision);
      continue;
    }
    const tier: RetentionTier =
      timestamp >= dayAgo
        ? "hour"
        : timestamp >= weekAgo
          ? "day"
          : timestamp >= monthAgo
            ? "week"
            : timestamp >= yearAgo
              ? "month"
              : "year";
    const bucket = bucketFor(tier, createdAt);
    const existing = buckets.get(bucket.key);
    if (existing) existing.rows.push(candidate);
    else buckets.set(bucket.key, { bucket, rows: [candidate] });
  }

  for (const { rows } of buckets.values()) {
    for (const candidate of chooseBucketCandidates(rows)) {
      recent.add(candidate.revision);
    }
  }
  return recent;
}

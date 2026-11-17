import { z } from "zod";

// Public package versions use strict numeric SemVer; preview status is a separate channel.
const identifier = "[0-9A-Za-z-]+";
const versionPattern = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+(${identifier}(?:\\.${identifier})*))?$`,
);
export function parseVersion(value: string) {
  const match = value.match(versionPattern);
  if (!match || value.length > 80) return null;
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split(".") ?? [];
  if (
    core.some((n) => !Number.isSafeInteger(n)) ||
    pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))
  )
    return null;
  return { core, pre };
}
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error("Invalid version");
  for (let i = 0; i < 3; i++) {
    const difference = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return x.length !== y.length ? Math.sign(x.length - y.length) : x < y ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export const StableVersionSchema = z
  .string()
  .max(80)
  .refine((value) => {
    const parsed = parseVersion(value);
    return parsed !== null && parsed.pre.length === 0;
  });
export const UpdateReleaseSchema = z
  .object({
    version: StableVersionSchema,
    platform: z.enum(["win32", "darwin", "openharmony"]),
    arch: z.enum(["x64", "arm64"]),
    publishedAt: z.iso.datetime({ offset: true }),
    notes: z.array(z.string().trim().min(1).max(2000)).min(1).max(30),
    downloadUrl: z.string().url().max(2048),
    classificationVersion: z.string().trim().min(1).max(80).optional(),
    systemRequirement: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type UpdateRelease = z.infer<typeof UpdateReleaseSchema>;
export const UpdateFeedSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.enum(["stable", "preview"]),
    releases: z.array(UpdateReleaseSchema).max(200),
  })
  .strict()
  .refine((feed) => {
    const keys = feed.releases.map(
      (release) =>
        `${release.platform}:${release.arch}:${parseVersion(release.version)?.core.join(".")}`,
    );
    return new Set(keys).size === keys.length;
  }, "Duplicate release version for a platform/architecture");
export const UpdateStateSchema = z
  .object({
    currentVersion: z.string().max(80),
    channel: z.enum(["stable", "preview"]).optional(),
    status: z.enum([
      "idle",
      "checking",
      "available",
      "latest",
      "error",
      "unconfigured",
      "unavailable",
    ]),
    release: UpdateReleaseSchema.nullable(),
    lastCheckedAt: z.iso.datetime().nullable(),
    message: z.string().max(500),
    notification: z.boolean(),
    sourceHost: z.string().max(255).nullable(),
  })
  .strict();
export type UpdateState = z.infer<typeof UpdateStateSchema>;
export const UpdateDismissSchema = z
  .object({ version: StableVersionSchema, action: z.enum(["later", "skip"]) })
  .strict();
export const UPDATE_OPEN_EVENT = "software-updates-open";
export const UPDATE_RECOMMENDATION =
  "每次启动后自动检查新版本，运行期间每隔 2 小时检查一次。建议保持开启，以获取问题修复、体验改进和分类号数据库更新。";

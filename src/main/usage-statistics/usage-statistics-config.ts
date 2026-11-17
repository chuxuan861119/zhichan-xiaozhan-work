import { createHash } from "node:crypto";
import { z } from "zod";
import channel from "../../../resources/usage-statistics-channel.json" with { type: "json" };
import {
  DisclosureSchema,
  ReleaseChannelSchema,
  sameUsageRelease,
  UsageReleaseSchema,
  USAGE_RETRY_DAYS,
  USAGE_PUBLICATION_DELAY_DAYS,
  usagePlatform,
  VersionGroupSchema,
} from "../../shared/usage-statistics/model.js";

export const UsageConfigSchema = z
  .object({
    endpoint: z.string().max(2048),
    noticeVersion: z.string().trim().min(1).max(80),
    acceptedPlatforms: z.array(z.enum(["win32", "darwin", "openharmony"])).max(3),
    publicVersionGroups: z.array(VersionGroupSchema).max(200),
    releaseChannel: ReleaseChannelSchema.default("preview"),
    releases: z.array(UsageReleaseSchema).max(200).default([]),
    disclosure: DisclosureSchema,
  })
  .strict();
export type UsageConfig = z.infer<typeof UsageConfigSchema>;
export function secureUsageEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/v1/usage/daily-aggregate"
  )
    throw new Error("Invalid statistics endpoint");
  return url;
}
export function usageConfigAvailable(
  config: UsageConfig,
  platform: string,
  version: string,
): boolean {
  const canonical = usagePlatform(platform);
  if (!canonical) return false;
  const nativePlatform =
    canonical === "windows" ? "win32" : canonical === "macos" ? "darwin" : "openharmony";
  if (
    !config.endpoint ||
    !config.acceptedPlatforms.includes(nativePlatform) ||
    !config.releases.some((release) =>
      sameUsageRelease(release, {
        platform: canonical,
        version,
        channel: config.releaseChannel,
      }),
    ) ||
    !config.disclosure.operator ||
    !config.disclosure.contact ||
    !config.disclosure.recipient ||
    !config.disclosure.region ||
    !config.disclosure.securityLogNotice
  )
    return false;
  secureUsageEndpoint(config.endpoint);
  return true;
}
export function usageStatisticsConfig(): UsageConfig {
  const config = UsageConfigSchema.parse(channel);
  return { ...config, noticeVersion: usageScopeVersion(config) };
}

/** Endpoint and disclosure changes invalidate previous consent even if a version bump was missed. */
export function usageScopeVersion(config: UsageConfig): string {
  const scope = JSON.stringify([
    5, // Private exact aggregates require renewed consent; old choices are not carried forward.
    USAGE_RETRY_DAYS,
    USAGE_PUBLICATION_DELAY_DAYS,
    config.endpoint,
    config.disclosure.operator,
    config.disclosure.contact,
    config.disclosure.recipient,
    config.disclosure.region,
    config.disclosure.retentionMonths,
    config.disclosure.securityLogNotice,
  ]);
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return `${config.noticeVersion.slice(0, 63)}-${hash}`;
}

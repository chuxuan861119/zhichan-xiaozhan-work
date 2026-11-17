/** Public Harmony storage cannot publish by hard link or no-replace rename. */
export function usesHarmonyPublicFileCopy(
  path: string,
  platform: string = process.platform,
): boolean {
  return ["openharmony", "ohos"].includes(platform) && path.startsWith("/storage/Users/");
}

import {
  type RendererFailureLocation,
  RendererFailureLocationSchema,
} from "../../../shared/ipc/renderer-failure-location";

export function rendererFailureLocations(error: unknown): RendererFailureLocation[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  const locations: RendererFailureLocation[] = [];
  // Never forward exception messages, function names, full paths or full stacks.
  // Only actual frame lines and our packaged entry asset coordinates are useful.
  for (const frame of error.stack.slice(0, 16_384).split("\n").slice(1, 33)) {
    if (!/^\s+at /u.test(frame)) continue;
    const match =
      /(?:patent-app:\/\/app\/assets\/|file:\/\/\/[^\s()]*\/renderer\/assets\/)(index-[A-Za-z0-9_-]{8}\.js):(\d+):(\d+)(?:\)|$)/u.exec(
        frame,
      );
    if (!match) continue;
    const parsed = RendererFailureLocationSchema.safeParse({
      bundle: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
    });
    if (!parsed.success) continue;
    if (
      locations.some(
        (location) =>
          location.bundle === parsed.data.bundle &&
          location.line === parsed.data.line &&
          location.column === parsed.data.column,
      )
    )
      continue;
    locations.push(parsed.data);
    if (locations.length === 3) break;
  }
  return locations;
}

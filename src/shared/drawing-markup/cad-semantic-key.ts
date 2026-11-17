import type { DrawingProject } from "./model.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, v]) => [key, stable(v)]),
    );
  return value;
}
/** Detect business edits made by API/history paths that did not rebuild native proxies. */
export function cadSemanticKey(project: DrawingProject) {
  return semanticKey(project);
}

/** Accept interim stroke-version keys without rewriting existing label geometry. */
export function cadSemanticKeyMatches(project: DrawingProject): boolean {
  const saved = project.cad?.semanticKey;
  return !!saved && [undefined, 1, 2].some((version) => saved === semanticKey(project, version));
}

function semanticKey(project: DrawingProject, labelStrokeVersion?: number) {
  const appearance = project.cad?.objects
    ?.filter((o) => o.appearance)
    .map((o) => ({ id: o.id, kind: o.kind, appearance: o.appearance }));
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      stable({
        ...(project.annotations.length && labelStrokeVersion ? { labelStrokeVersion } : {}),
        annotations: project.annotations,
        detailViews: project.detailViews ?? [],
        baseFragments: project.baseFragments ?? [],
        ...(appearance?.length ? { appearance } : {}),
      }),
    ),
  );
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}

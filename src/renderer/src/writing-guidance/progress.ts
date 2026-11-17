export const GUIDANCE_PROGRESS_EVENT = "patent-workbench:guidance-progress";
export type GuidanceProgress = { scope: string; kind: "numbered" | "copied"; label: string };

// Publish only after the business operation succeeds; never infer success from a click.
export function reportGuidanceProgress(
  element: Element | null,
  kind: GuidanceProgress["kind"],
  label: string,
) {
  const owner = element?.closest("[data-function-rail-owner], [data-function-rail-scope]");
  const scope =
    owner?.getAttribute("data-function-rail-owner") ??
    owner?.getAttribute("data-function-rail-scope");
  if (scope)
    window.dispatchEvent(
      new CustomEvent<GuidanceProgress>(GUIDANCE_PROGRESS_EVENT, {
        detail: { scope, kind, label },
      }),
    );
}

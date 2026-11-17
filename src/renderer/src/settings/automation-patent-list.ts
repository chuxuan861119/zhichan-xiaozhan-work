import type { LibraryPatentSummary } from "../../../shared/library/model";

/** Only active patents are available for Agent authorization. */
export async function listAuthorizationPatents(): Promise<LibraryPatentSummary[]> {
  const result = await window.patentApi.patents.list("active");
  if (!result.ok) throw new Error("Unable to load patent authorization choices.");
  return result.value.filter((patent) => !patent.deletedAt);
}

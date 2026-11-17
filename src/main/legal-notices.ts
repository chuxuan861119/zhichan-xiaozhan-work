import { join } from "node:path";
import { AppOperationError } from "./app-operation-error.js";

type OpenPath = (path: string) => Promise<string>;

async function openBundledPath(
  applicationRoot: string,
  relativePath: readonly string[],
  openPath: OpenPath,
) {
  const failure = await openPath(join(applicationRoot, "resources", ...relativePath));
  if (failure) {
    throw new AppOperationError({
      code: "INTERNAL",
      message: `无法打开第三方声明：${failure}`,
    });
  }
}

export async function openBundledThirdPartyNotices(applicationRoot: string, openPath: OpenPath) {
  await openBundledPath(applicationRoot, ["THIRD_PARTY_NOTICES.txt"], openPath);
}

export async function openBundledThirdPartyLicenses(applicationRoot: string, openPath: OpenPath) {
  await openBundledPath(applicationRoot, ["licenses"], openPath);
}

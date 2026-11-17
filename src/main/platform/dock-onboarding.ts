import { writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

export function installedMacBundle(options: {
  platform: string;
  packaged: boolean;
  isolated: boolean;
  executable: string;
  home: string;
}): string | null {
  if (options.platform !== "darwin" || !options.packaged || options.isolated) return null;
  const { dirname, join, relative, resolve } = posix;
  const bundle = dirname(dirname(dirname(options.executable)));
  if (!bundle.endsWith(".app") || dirname(options.executable) !== join(bundle, "Contents", "MacOS"))
    return null;
  return ["/Applications", join(options.home, "Applications")].some((root) => {
    const child = relative(root, resolve(bundle));
    return child.length > 0 && !child.startsWith("..") && !child.startsWith("/");
  })
    ? bundle
    : null;
}

/** A machine-local, exclusive claim survives decline, crashes, updates and later Dock removal. */
export async function runDockOnboarding(options: {
  userData: string;
  contains(): Promise<boolean>;
  ask(): Promise<boolean>;
  add(): Promise<void>;
  reportFailure(): Promise<void>;
}) {
  try {
    await writeFile(join(options.userData, "mac-dock-onboarding-v1.json"), '{"prompted":true}\n', {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  if (await options.contains()) return;
  if (!(await options.ask())) return;
  try {
    await options.add();
  } catch {
    await options.reportFailure();
  }
}

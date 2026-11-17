import { isAbsolute, join, parse } from "node:path";
import { APPLICATION_DATA_DIRECTORY } from "../../shared/branding.js";
import { canonicalSystemPath } from "../platform/system-path.js";

const DEFAULT_LIBRARY_DIRECTORY = "Library";

export type LibraryEnvironment = Readonly<{
  ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT?: string | undefined;
  PATENT_WORKBENCH_LIBRARY_ROOT?: string | undefined;
}>;

export type LibraryRootOptions = {
  localAppData: string;
  override?: string | null | undefined;
};

function ensureUsableAbsolutePath(label: string, path: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`);
  const resolved = canonicalSystemPath(path);
  if (parse(resolved).root === resolved) throw new Error(`${label} must not be a filesystem root.`);
  return resolved;
}

export function resolveLibraryRoot(options: LibraryRootOptions): string {
  ensureUsableAbsolutePath("localAppData", options.localAppData);
  if (options.override !== undefined && options.override !== null) {
    return ensureUsableAbsolutePath("library override", options.override);
  }
  return ensureUsableAbsolutePath(
    "library root",
    join(options.localAppData, APPLICATION_DATA_DIRECTORY, DEFAULT_LIBRARY_DIRECTORY),
  );
}

export function resolveLibraryOverride(environment: LibraryEnvironment): string | undefined {
  const current = environment.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT || undefined;
  const legacy = environment.PATENT_WORKBENCH_LIBRARY_ROOT || undefined;
  const resolvedCurrent =
    current === undefined ? undefined : ensureUsableAbsolutePath("library override", current);
  const resolvedLegacy =
    legacy === undefined ? undefined : ensureUsableAbsolutePath("legacy library override", legacy);
  if (resolvedCurrent !== undefined && resolvedLegacy !== undefined) {
    const normalize = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
    if (normalize(resolvedCurrent) !== normalize(resolvedLegacy)) {
      throw new Error("新旧专利库环境变量指向不同目录。");
    }
  }
  return resolvedCurrent ?? resolvedLegacy;
}

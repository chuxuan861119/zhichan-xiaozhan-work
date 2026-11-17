import { join, parse, resolve } from "node:path";
import { resolveLibraryOverride, resolveLibraryRoot } from "./library-paths.js";

describe("library paths", () => {
  test("resolves the default library under an absolute LocalAppData base", () => {
    const base = resolve("test-local-appdata");
    expect(resolveLibraryRoot({ localAppData: base })).toBe(
      join(base, "ZhichanXiaozhanWork", "Library"),
    );
  });

  test("uses the renamed override and keeps the legacy variable as an alias", () => {
    const current = resolve("D:\\current-library");
    const legacy = resolve("D:\\legacy-library");

    expect(resolveLibraryOverride({ ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT: current })).toBe(current);
    expect(resolveLibraryOverride({ PATENT_WORKBENCH_LIBRARY_ROOT: legacy })).toBe(legacy);
    expect(
      resolveLibraryOverride({
        ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT: current,
        PATENT_WORKBENCH_LIBRARY_ROOT: current,
      }),
    ).toBe(current);
  });

  test("rejects conflicting renamed and legacy overrides", () => {
    const current = resolve("D:\\current-library");
    const legacy = resolve("D:\\legacy-library");

    expect(() =>
      resolveLibraryOverride({
        ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT: current,
        PATENT_WORKBENCH_LIBRARY_ROOT: legacy,
      }),
    ).toThrow("指向不同目录");
  });

  test("accepts an explicit absolute test override", () => {
    const override = resolve("D:\\专利工作台-test-library");

    expect(
      resolveLibraryRoot({
        localAppData: resolve("test-local-appdata"),
        override,
      }),
    ).toBe(override);
  });

  test("rejects relative and root-only library locations", () => {
    expect(() => resolveLibraryRoot({ localAppData: "relative" })).toThrow("absolute");
    expect(() =>
      resolveLibraryRoot({
        localAppData: resolve("test-local-appdata"),
        override: "relative-library",
      }),
    ).toThrow("absolute");
    expect(() =>
      resolveLibraryRoot({
        localAppData: resolve("test-local-appdata"),
        override: parse(resolve("D:\\")).root,
      }),
    ).toThrow("root");
  });
});

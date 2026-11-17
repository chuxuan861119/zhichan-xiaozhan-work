import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AppOperationError } from "./app-operation-error.js";
import { openBundledThirdPartyLicenses, openBundledThirdPartyNotices } from "./legal-notices.js";

describe("bundled legal notices", () => {
  test("opens the fixed bundled third-party notice file", async () => {
    const openPath = vi.fn(async () => "");

    await openBundledThirdPartyNotices("C:\\Program Files\\知产小栈Work", openPath);

    expect(openPath).toHaveBeenCalledWith(
      join("C:\\Program Files\\知产小栈Work", "resources", "THIRD_PARTY_NOTICES.txt"),
    );
  });

  test("opens the fixed bundled licenses directory", async () => {
    const openPath = vi.fn(async () => "");

    await openBundledThirdPartyLicenses("C:\\Program Files\\知产小栈Work", openPath);

    expect(openPath).toHaveBeenCalledWith(
      join("C:\\Program Files\\知产小栈Work", "resources", "licenses"),
    );
  });

  test("reports an operating-system failure instead of silently succeeding", async () => {
    const openPath = vi.fn(async () => "No associated application");

    await expect(
      openBundledThirdPartyNotices("C:\\Program Files\\知产小栈Work", openPath),
    ).rejects.toBeInstanceOf(AppOperationError);
  });
});

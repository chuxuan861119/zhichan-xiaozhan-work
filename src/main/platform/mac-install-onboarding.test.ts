import { expect, test, vi } from "vitest";
import { offerMacInstallation, shouldOfferMacInstallation } from "./mac-install-onboarding.js";

const base = {
  platform: "darwin",
  packaged: true,
  mas: false,
  isolated: false,
  inApplications: false,
  executable: "/Volumes/Work/知产小栈Work.app/Contents/MacOS/知产小栈Work",
};
test("only a real packaged download-disk startup offers installation", () => {
  expect(shouldOfferMacInstallation(base)).toBe(true);
  for (const patch of [
    { platform: "win32" },
    { packaged: false },
    { mas: true },
    { isolated: true },
    { inApplications: true },
    { executable: "/tmp/testing.app/Contents/MacOS/Work" },
  ])
    expect(shouldOfferMacInstallation({ ...base, ...patch })).toBe(false);
});
test("quarantined DMG and extracted Downloads apps also receive the installation entry", () => {
  expect(
    shouldOfferMacInstallation({
      ...base,
      executable:
        "/private/var/folders/fm/test/T/AppTranslocation/uuid/d/Work.app/Contents/MacOS/Work",
    }),
  ).toBe(true);
  expect(
    shouldOfferMacInstallation({
      ...base,
      downloads: "/Users/test/Downloads",
      executable: "/Users/test/Downloads/Work.app/Contents/MacOS/Work",
    }),
  ).toBe(true);
});
function deps() {
  return {
    ask: vi.fn(async (_kind: "install" | "replace") => true),
    move: vi.fn((_conflict: (type: string) => boolean) => true),
    confirmReplace: vi.fn(() => false),
    inform: vi.fn(async (_reason: "running" | "cancelled" | "failed") => undefined),
  };
}
test("successful install stops current startup because the installed copy relaunches", async () => {
  const d = deps();
  expect(await offerMacInstallation(d)).toBe("relaunching");
  expect(d.move).toHaveBeenCalledOnce();
});
test("decline or cancelled system authorization can continue using the mounted copy", async () => {
  const d = deps();
  d.ask.mockResolvedValue(false);
  expect(await offerMacInstallation(d)).toBe("continue");
  expect(d.move).not.toHaveBeenCalled();
  d.ask.mockResolvedValue(true);
  d.move.mockReturnValue(false);
  expect(await offerMacInstallation(d)).toBe("continue");
  expect(d.inform).toHaveBeenCalledWith("cancelled");
});
test("never overwrites or closes a running installed copy and replacement requires confirmation", async () => {
  const d = deps();
  d.move.mockImplementation((conflict) => conflict("existsAndRunning"));
  expect(await offerMacInstallation(d)).toBe("continue");
  expect(d.inform).toHaveBeenCalledWith("running");
  d.move.mockImplementation((conflict) => conflict("exists"));
  expect(await offerMacInstallation(d)).toBe("continue");
  expect(d.confirmReplace).toHaveBeenCalledOnce();
  d.confirmReplace.mockReturnValue(true);
  expect(await offerMacInstallation(d)).toBe("relaunching");
});
test("copy failure reports recovery guidance and leaves startup available", async () => {
  const d = deps();
  d.move.mockImplementation(() => {
    throw new Error("copy failure");
  });
  expect(await offerMacInstallation(d)).toBe("continue");
  expect(d.inform).toHaveBeenCalledWith("failed");
});

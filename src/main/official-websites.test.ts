import { APPLICATION_WEBSITE } from "../shared/branding.js";
import { OFFICIAL_WEBSITES } from "../shared/official-websites.js";
import { openOfficialWebsite } from "./official-websites.js";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("electron", () => ({ shell: { openExternal: mocks.open } }));
beforeEach(() => vi.resetAllMocks());
test("opens all 19 approved sites in the system browser", async () => {
  expect(OFFICIAL_WEBSITES).toHaveLength(19);
  expect(new Set(OFFICIAL_WEBSITES.map((site) => site.url)).size).toBe(19);
  for (const site of OFFICIAL_WEBSITES) {
    await openOfficialWebsite(site.id);
    expect(mocks.open).toHaveBeenLastCalledWith(site.url);
  }
});
test.each([
  "https://example.com",
  "file:///C:/Windows",
  "javascript:alert(1)",
  "toString",
  null,
  { id: "cnipa" },
])("rejects arbitrary external targets: %s", async (input) => {
  await expect(openOfficialWebsite(input)).rejects.toThrow();
  expect(mocks.open).not.toHaveBeenCalled();
});
test("propagates browser launch failures", async () => {
  mocks.open.mockRejectedValueOnce(new Error("browser unavailable"));
  await expect(openOfficialWebsite("cnipa")).rejects.toThrow("browser unavailable");
});

test("opens the product homepage without adding it to patent business shortcuts", async () => {
  await openOfficialWebsite("work-home");
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith(APPLICATION_WEBSITE);
});

test("opens only the fixed corresponding-source page", async () => {
  await openOfficialWebsite("work-open-source");
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://zcxzz.cn/open-source/");
});

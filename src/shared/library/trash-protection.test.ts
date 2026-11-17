import { canPermanentlyDeletePatent } from "./trash-protection.js";

test("requires a valid deletion time and a full 24-hour interval", () => {
  const start = Date.parse("2026-09-13T00:00:00Z");
  expect(canPermanentlyDeletePatent(null, start)).toBe(false);
  expect(canPermanentlyDeletePatent("invalid", start)).toBe(false);
  expect(canPermanentlyDeletePatent("2026-09-13T00:00:00Z", start - 1)).toBe(false);
  expect(canPermanentlyDeletePatent("2026-09-13T00:00:00Z", start + 86400000 - 1)).toBe(false);
  expect(canPermanentlyDeletePatent("2026-09-13T00:00:00Z", start + 86400000)).toBe(true);
});

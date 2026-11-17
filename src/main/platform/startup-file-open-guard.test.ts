import { harmonyPatdocPath } from "./harmony-open-file.js";
import { createStartupFileOpenGuard } from "./startup-file-open-guard.js";

test("one startup request delivered through arguments and native events imports once, while later explicit opens remain possible", () => {
  let now = 0;
  const guard = createStartupFileOpenGuard(2000, () => now);
  const uri = "file://docs/storage/Users/currentUser/Download/test.patdoc";
  const path = harmonyPatdocPath(uri);
  expect(guard.accept(path)).toBe(true);
  expect(
    guard.accept(harmonyPatdocPath(`zhichan-patdoc://open?uri=${encodeURIComponent(uri)}`)),
  ).toBe(false);
  expect(guard.accept("/another.patdoc")).toBe(true);
  guard.finish();
  now = 53;
  expect(guard.accept(path)).toBe(false);
  now = 2000;
  expect(guard.accept(path)).toBe(true);
  now = 4000;
  expect(guard.accept(path)).toBe(true);
});

test("other platforms retain immediate explicit reopening after startup", () => {
  const guard = createStartupFileOpenGuard();
  expect(guard.accept("/test.patdoc")).toBe(true);
  guard.finish();
  expect(guard.accept("/test.patdoc")).toBe(true);
});

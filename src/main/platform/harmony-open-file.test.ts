import { harmonyPatdocPath } from "./harmony-open-file.js";

test("Harmony file requests decode Chinese paths without treating a URI as a relative path", () => {
  const uri = "file://docs/storage/Users/currentUser/Download/%E6%B5%8B%E8%AF%95%20%23%25.patdoc";
  expect(harmonyPatdocPath(uri)).toBe("/storage/Users/currentUser/Download/测试 #%.patdoc");
  expect(harmonyPatdocPath(`zhichan-patdoc://open?uri=${encodeURIComponent(uri)}`)).toBe(
    "/storage/Users/currentUser/Download/测试 #%.patdoc",
  );
});

test.each([
  "https://example.com/a.patdoc",
  "file://remote/share/a.patdoc",
  "file:///tmp/a.patdoc?x=1",
  "file:///tmp/a.patdoc#fragment",
  "file:///tmp/a%2fb.patdoc",
  "file:///tmp/a%00.patdoc",
  "file:///tmp/a.patdoc.exe",
  "file:///tmp/%ZZ.patdoc",
  "a.patdoc",
  "zhichan-patdoc://other?uri=file:///a.patdoc",
  "zhichan-patdoc://open?uri=file:///a.patdoc&uri=file:///b.patdoc",
])("rejects unsupported or ambiguous external requests: %s", (input) =>
  expect(harmonyPatdocPath(input)).toBeNull(),
);

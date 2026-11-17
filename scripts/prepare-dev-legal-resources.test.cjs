const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
test("copies and verifies the complete legal resource tree", () => {
  const { prepareDevLegalResources } = require("./prepare-dev-legal-resources.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-resource-test-"));
  const source = path.join(root, "source");
  const target = path.join(root, "app");
  fs.mkdirSync(path.join(source, "licenses", "component"), { recursive: true });
  fs.writeFileSync(path.join(source, "THIRD_PARTY_NOTICES.txt"), "notices");
  fs.writeFileSync(path.join(source, "licenses", "component", "LICENSE"), "license");
  prepareDevLegalResources(source, target);
  assert.equal(
    fs.readFileSync(path.join(target, "resources", "licenses", "component", "LICENSE"), "utf8"),
    "license",
  );
  assert.equal(
    fs.readFileSync(path.join(target, "resources", "THIRD_PARTY_NOTICES.txt"), "utf8"),
    "notices",
  );
  assert.throws(() => prepareDevLegalResources(path.join(root, "missing"), target));
});

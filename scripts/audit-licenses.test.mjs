import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertLicenseAllowed, generateThirdPartyNotices } from "./audit-licenses.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const rootDirectory = fileURLToPath(new URL("../", import.meta.url));

test("retired chart dependencies are absent", () => {
  for (const name of ["echarts", "papaparse", "zrender"])
    assert.equal(packageJson.dependencies[name], undefined);
});

test("license gate rejects unknown, copyleft and non-commercial declarations", () => {
  for (const license of [
    "",
    "UNKNOWN",
    "GPL-3.0-only",
    "AGPL-3.0-only",
    "CC-BY-NC-SA-4.0",
    "Proprietary",
  ]) {
    assert.throws(() => assertLicenseAllowed("candidate@1.0.0", license));
  }
  assert.doesNotThrow(() => assertLicenseAllowed("candidate@1.0.0", "Apache-2.0"));
});

test("third-party notices exclude retired chart libraries", async () => {
  const notices = await generateThirdPartyNotices(rootDirectory, {
    platform: process.platform,
    arch: process.arch,
  });
  assert.doesNotMatch(notices, /^(?:echarts|papaparse|zrender) \d/gmu);
  assert.doesNotMatch(notices, /\r/, "generated notices use the repository LF line endings");
});

test("committed third-party notices do not duplicate mathml-to-latex", async () => {
  const notices = await readFile(
    new URL("../resources/THIRD_PARTY_NOTICES.txt", import.meta.url),
    "utf8",
  );

  assert.equal(
    notices.match(/^mathml-to-latex 1\.8\.0$/gmu)?.length ?? 0,
    1,
    "mathml-to-latex should have one normalized notice entry",
  );
});

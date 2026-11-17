import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = resolve(root, "resources/ipc-data-center");
const bytes = readFileSync(resolve(assetRoot, "js/db-preexam.js"));
const provenance = JSON.parse(
  readFileSync(resolve(assetRoot, "data/preexam-provenance-20261017.json"), "utf8"),
);
const plain = (value) => JSON.parse(JSON.stringify(value));
const context = vm.createContext({});
context.window = context;
context.self = context;
context.getPreferredRegion = () => null;
for (const name of ["db-ipc", "db-locarno", "db-priority", "db-preexam"]) {
  vm.runInContext(readFileSync(resolve(assetRoot, `js/${name}.js`), "utf8"), context);
}
vm.runInContext(readFileSync(resolve(assetRoot, "query-core.js"), "utf8"), context);
const database = plain(context.protectionCenterDatabase);
const countCenters = (data) =>
  Object.values(data).reduce((sum, centers) => sum + Object.keys(centers).length, 0);

test("all 15 existing centers and their original source bytes remain unchanged", () => {
  const prefix = bytes.subarray(0, provenance.baseline.byte_length);
  assert.equal(createHash("sha256").update(prefix).digest("hex"), provenance.baseline.sha256);
  assert.equal(countCenters(provenance.baseline.centers), 15);
  for (const [province, centers] of Object.entries(provenance.baseline.centers)) {
    for (const [name, before] of Object.entries(centers))
      assert.deepEqual(database[province][name], before);
  }
});

test("39 new centers have exactly the reviewed unique code sets and valid dictionary entries", () => {
  assert.equal(countCenters(provenance.additions), 39);
  assert.equal(countCenters(database), 54);
  let ipc = 0;
  let locarno = 0;
  for (const [province, centers] of Object.entries(provenance.additions)) {
    for (const [name, entry] of Object.entries(centers)) {
      assert.deepEqual(database[province][name], entry);
      assert.equal(provenance.baseline.centers[province]?.[name], undefined);
      for (const kind of ["ipc", "locarno"]) {
        assert.ok(entry[kind].length > 0);
        assert.equal(new Set(entry[kind]).size, entry[kind].length);
        const pattern = kind === "ipc" ? /^[A-H]\d{2}[A-Z]?(?:\d+\/\d+)?$/ : /^\d{2}-\d{2}$/;
        const dictionary = kind === "ipc" ? context.ipcDictionary : context.locarnoDictionary;
        for (const code of entry[kind]) {
          assert.match(code, pattern);
          assert.ok(Object.hasOwn(dictionary, code), `${province}/${name}: ${code}`);
        }
      }
      ipc += entry.ipc.length;
      locarno += entry.locarno.length;
    }
  }
  assert.equal(ipc, 4617);
  assert.equal(locarno, 1097);
});

test("every new code is traceable to source files and only the documented Ningxia source count is unresolved", () => {
  assert.equal(provenance.sources.length, 56);
  assert.equal(provenance.centers.length, 51);
  const mismatches = [];
  for (const source of provenance.sources) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    for (const [kind, expected] of Object.entries(source.verification.declared_source_counts)) {
      const actual = source.verification.observed_row_counts[kind] || 0;
      if (actual !== expected) mismatches.push([source.center, kind, expected, actual]);
    }
  }
  assert.deepEqual(mismatches, [["宁夏", "ipc", 172, 171]]);
  for (const center of provenance.centers.filter((item) => item.action === "add-new-center")) {
    const sources = provenance.sources.filter((source) => center.source_keys.includes(source.key));
    for (const kind of ["ipc", "locarno"]) {
      const codes = [...new Set(sources.flatMap((source) => source[kind]))].sort();
      assert.deepEqual(database[center.province][center.name][kind], codes);
    }
  }
  assert.equal(database.宁夏.宁夏保护中心.ipc.length, 171);
  assert.equal(provenance.source_issues[0].completeness, "source-gap");
});

test("source repetitions are deduplicated without counting explanatory cross-references as eligible codes", () => {
  assert.equal(database.河南.新乡保护中心.ipc.filter((code) => code === "G01M").length, 1);
  assert.equal(database.安徽.合肥保护中心.locarno.filter((code) => code === "24-01").length, 1);
  assert.equal(database.广西.南宁保护中心.ipc.length, 106);
  assert.equal(database.广西.南宁保护中心.locarno.length, 38);
  assert.ok(database.黑龙江.黑龙江省保护中心.ipc.includes("G05D"));
  assert.ok(!database.黑龙江.黑龙江省保护中心.ipc.includes("G05D11/16"));
  assert.ok(!database.内蒙古.内蒙古保护中心.ipc.includes("B65G45/10"));
  assert.ok(database.吉林.长春保护中心.ipc.includes("H04J"));
  assert.ok(!database.吉林.长春保护中心.ipc.includes("HO4J"));
});

test("Liaoning matches the independently reread source image: 23-03, not 23-05", () => {
  const center = database.辽宁.辽宁省保护中心;
  assert.ok(center.locarno.includes("23-03"));
  assert.ok(!center.locarno.includes("23-05"));
  const source = provenance.sources.find((entry) => entry.key === "辽宁-01");
  assert.ok(source.locarno.includes("23-03"));
  assert.ok(!source.locarno.includes("23-05"));
  context.addEventListener = () => {};
  vm.runInContext(readFileSync(resolve(assetRoot, "app.js"), "utf8"), context);
  const html = context.generateClassificationList(center.locarno, "locarno", "辽宁省保护中心");
  assert.ok(html.includes("23-03"));
  assert.ok(!html.includes("23-05"));
});

test("the production query engine finds every new center, including broad IPC classes and image-only sources", () => {
  for (const [province, centers] of Object.entries(provenance.additions)) {
    for (const [name, center] of Object.entries(centers)) {
      const matches = context.findCentersByCode(center.ipc[0]);
      assert.ok(
        matches.some((entry) => entry.province === province && entry.name === name),
        name,
      );
    }
  }
  assert.ok(context.findCentersByCode("B21D1/00").some((item) => item.name === "常州保护中心"));
  assert.ok(
    context
      .findPreExamByKeyword("H10F")
      .some((item) => item.centers.some((center) => center.name === "泉州保护中心")),
  );
  assert.equal(database.福建.泉州保护中心.ipc.length, 131);
  assert.equal(database.福建.泉州保护中心.locarno.length, 27);
  assert.equal(database.湖北.宜昌保护中心.ipc.length, 106);
  assert.equal(database.湖北.宜昌保护中心.locarno.length, 21);
});

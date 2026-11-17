import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

test("ships the complete offline query tool without expiry or collection code", () => {
  const root = resolve("resources/ipc-data-center");
  expect(existsSync(root)).toBe(true);
  const html = readFileSync(resolve(root, "index.html"), "utf8");
  const app = readFileSync(resolve(root, "app.js"), "utf8");
  expect(html + app).not.toMatch(
    /TRIAL_CONFIG|EXPIRE_TIME|transferStation|购物车|中转站|plus\.|navigator\.clipboard/iu,
  );
  for (const id of [
    "queryIPCBtn",
    "preExamBtn",
    "priorityBtn",
    "dictionaryBtn",
    "protectionBtn",
    "shareReportBtn",
  ])
    expect(html).toContain(`id="${id}"`);
  for (const file of ["db-ipc.js", "db-preexam.js", "db-priority.js", "db-locarno.js"])
    expect(existsSync(resolve(root, "js", file))).toBe(true);
});

test("retains hierarchy, group boundaries, keyword matching and priority exclusions", () => {
  const context = createContext({});
  context.window = context;
  for (const file of [
    "js/db-ipc.js",
    "js/db-preexam.js",
    "js/db-priority.js",
    "js/db-locarno.js",
    "query-core.js",
  ])
    runInContext(readFileSync(resolve("resources/ipc-data-center", file), "utf8"), context);
  runInContext("function getPreferredRegion() { return null; }", context);
  const result = runInContext(
    `JSON.stringify({
    children: buildClassificationIndexPayload().index.mainGroups['A01B1/00'].slice(0, 4),
    matches: findRelatedMatches('A01B1*').map(item => item.code),
    keyword: findRelatedMatches('手动工具', true).map(item => item.code),
    priorityKeyword: calculatePriorityResults('人工智能').length,
    excluded: isClassificationMatchWithExclusion('G06F11/14', 'G06F11*(不含 G06F11/14、G06F11/36)', getAllClassificationPrefixes('G06F11/14'), false),
    accepted: isClassificationMatchWithExclusion('G06F11', 'G06F11*(不含 G06F11/14、G06F11/36)', getAllClassificationPrefixes('G06F11'), false),
    preexam: findPreExamByKeyword('测量').map(item => ({ code: item.code, centers: item.centers.length }))
  })`,
    context,
  );
  const data = JSON.parse(result);
  expect(data.children).toEqual(["A01B1/02", "A01B1/04", "A01B1/06", "A01B1/08"]);
  expect(data.matches).toContain("A01B1/00");
  expect(data.matches).not.toContain("A01B11/00");
  expect(data.keyword).toContain("A01B1/00");
  expect(data.priorityKeyword).toBeGreaterThan(0);
  expect(data.excluded).toBe(false);
  expect(data.accepted).toBe(true);
  expect(data.preexam.length).toBeGreaterThan(0);
  expect(data.preexam.every((item: { centers: number }) => item.centers > 0)).toBe(true);
});

function queryContext() {
  const context = createContext({});
  context.window = context;
  for (const file of ["js/db-ipc.js", "js/db-priority.js", "query-core.js"])
    runInContext(readFileSync(resolve("resources/ipc-data-center", file), "utf8"), context);
  return context;
}

test("preexam keyword results do not omit matching groups when a subclass also matches", () => {
  const context = queryContext();
  runInContext(
    readFileSync(resolve("resources/ipc-data-center/js/db-preexam.js"), "utf8"),
    context,
  );
  const data = JSON.parse(
    runInContext(
      `
    function getPreferredRegion() { return null; }
    JSON.stringify({
      actual: findPreExamByKeyword('测量').map(row => row.code),
      expected: Object.entries(ipcDictionary).filter(([code, title]) =>
        parseDeletedIpcTitle(title, code).searchableTitle.includes('测量') &&
        findCentersByCode(code).length > 0).map(([code]) => code)
    })`,
      context,
    ),
  );
  expect(data.actual).toEqual(expect.arrayContaining(data.expected));
});

test("preexam section input reaches the explicit scope restriction rather than keyword search", () => {
  const context = queryContext();
  context.addEventListener = () => {};
  runInContext(readFileSync(resolve("resources/ipc-data-center/app.js"), "utf8"), context);
  runInContext(
    `
    var viewRevision = 0;
    var restricted = null;
    var searched = null;
    ensureClassificationIndexReady = () => true;
    updateStatusDisplay = () => {};
    showFloatingButtons = () => {};
    showPreExamRestrictionModal = type => { restricted = type; };
    searchPreExamByKeyword = query => { searched = query; };
    queryPreExam('a');
  `,
    context,
  );
  expect(context.restricted).toBe("部");
  expect(context.searched).toBeNull();
});

test("priority includes ancestor ranges and applies each exclusion without crossing group boundaries", () => {
  const context = queryContext();
  const data = JSON.parse(
    runInContext(
      `JSON.stringify({
    match: calculatePriorityResults('A01B1/02'),
    allowed: isClassificationMatchWithExclusion('G06F11/10', 'G06F11*(不含 G06F11/14、G06F11/36)', [], false),
    first: isClassificationMatchWithExclusion('G06F11/14', 'G06F11*(不含 G06F11/14、G06F11/36)', [], false),
    second: isClassificationMatchWithExclusion('G06F11/36', 'G06F11*(不含 G06F11/14、G06F11/36)', [], false),
    neighbor: isClassificationMatch('A01B11/00', 'A01B1*', [], false),
    exact: isClassificationMatch('A01B1/02', 'A01B*', [], true)
  })`,
      context,
    ),
  );
  expect(
    data.match.some((row: { matchingClassifications: string[] }) =>
      row.matchingClassifications.includes("A01B*"),
    ),
  ).toBe(true);
  expect(data.allowed).toBe(true);
  expect(data.first).toBe(false);
  expect(data.second).toBe(false);
  expect(data.neighbor).toBe(false);
  expect(data.exact).toBe(false);
});

test("wildcards include descendants and spaced classification input is normalized", () => {
  const context = queryContext();
  const data = JSON.parse(
    runInContext(
      `JSON.stringify({
    classes: findRelatedMatches('A01*').map(row => row.code),
    groups: findRelatedMatches('A01B*').map(row => row.code),
    spaced: calculatePriorityResults('a01b　1/02'),
    compact: calculatePriorityResults('A01B1/02')
  })`,
      context,
    ),
  );
  expect(data.classes).toContain("A01B");
  expect(data.groups).toContain("A01B1/02");
  expect(data.spaced).toEqual(data.compact);
  expect(data.spaced.length).toBeGreaterThan(0);
});

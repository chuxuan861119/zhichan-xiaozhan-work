import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { beforeEach, expect, test, vi } from "vitest";

const root = "resources/ipc-data-center/";
const municipalities = ["北京", "天津", "上海", "重庆"];

function loadList() {
  document.body.innerHTML = '<div id="protectionCenterContent"></div>';
  const context = createContext({
    document,
    localStorage,
    addEventListener: vi.fn(),
    workbenchUi: {
      replaceContent: (_element: HTMLElement, update: () => void) => update(),
    },
  });
  context.window = context;
  for (const file of ["js/db-preexam.js", "query-core.js", "app.js"])
    runInContext(readFileSync(root + file, "utf8"), context);
  return context;
}

beforeEach(() => localStorage.clear());

test("every province and autonomous region groups its centers, even when there is only one", () => {
  const context = loadList();
  runInContext("generateProtectionCenterList()", context);
  const database = context.protectionCenterDatabase as Record<string, Record<string, unknown>>;
  expect(
    Object.values(database).reduce((count, centers) => count + Object.keys(centers).length, 0),
  ).toBe(54);
  for (const [region, centers] of Object.entries(database)) {
    const names = Object.keys(centers);
    const group = document.getElementById(`province-${region}-content`);
    if (municipalities.includes(region) && names.length === 1) {
      expect(group, region).toBeNull();
      expect(document.getElementById("protectionCenterContent")?.textContent).toContain(names[0]);
    } else {
      expect(group, region).not.toBeNull();
      expect(group?.classList.contains("hidden"), region).toBe(true);
      expect(group?.children.length, region).toBe(names.length);
      for (const name of names) expect(group?.textContent, region).toContain(name);
      expect(document.getElementById(`province-${region}-header`)?.textContent).toContain(
        `${names.length} 个保护中心`,
      );
    }
  }
});

test("each municipality is direct with one center and grouped with two; preferred regions still come first", () => {
  const context = loadList();
  for (const region of municipalities) {
    context.protectionCenterDatabase = { [region]: { 示例中心一: {} } };
    runInContext("generateProtectionCenterList()", context);
    expect(document.getElementById(`province-${region}-header`)).toBeNull();
    context.protectionCenterDatabase = { [region]: { 示例中心一: {}, 示例中心二: {} } };
    runInContext("generateProtectionCenterList()", context);
    expect(document.getElementById(`province-${region}-content`)?.children.length).toBe(2);
  }
  context.protectionCenterDatabase = { 山东: { 示例中心一: {} }, 河北: { 示例中心二: {} } };
  localStorage.setItem("preferredProtectionRegion", "河北");
  runInContext("generateProtectionCenterList()", context);
  expect(document.querySelector("#protectionCenterContent > :first-child")?.textContent).toContain(
    "河北",
  );
});

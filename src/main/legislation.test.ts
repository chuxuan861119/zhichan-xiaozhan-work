import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDITIONAL_LEGISLATION } from "../shared/legislation-extra.js";
import { legislationParagraphs } from "../shared/legislation-text.js";
import { performLegislationAction } from "./legislation.js";

const mocks = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("electron", () => ({
  dialog: { showSaveDialog: mocks.save },
  shell: { openExternal: mocks.open },
}));
vi.mock("../renderer/src/legislation/assets/guidelines-2025.pdf?asset", () => ({
  default: "src/renderer/src/legislation/assets/guidelines-2025.pdf",
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test("every additional document saves its own complete bundled text and version note", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legislation-extra-test-"));
  for (const item of ADDITIONAL_LEGISLATION) {
    const file = join(directory, `${item.id}.txt`);
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: file });
    await performLegislationAction({ id: item.id, action: "save" });
    const text = await readFile(file, "utf8");
    expect(text).toContain(legislationParagraphs(item.id).join("\r\n\r\n"));
    expect(text).toContain(item.title);
    if (item.note) expect(text).toContain(item.note);
    await performLegislationAction({ id: item.id, action: "source" });
    expect(mocks.open).toHaveBeenLastCalledWith(item.source);
  }
});
test("permits only bundled official source IDs", async () => {
  await expect(
    performLegislationAction({ id: "https://example.com", action: "source" }),
  ).rejects.toThrow();
  expect(mocks.open).not.toHaveBeenCalled();
  await performLegislationAction({ id: "guidelines", action: "source" });
  expect(mocks.open).toHaveBeenCalledWith(
    "https://www.cnipa.gov.cn/art/2025/11/14/art_99_202568.html",
  );
});
test("saves complete text and the unmodified official PDF, and permits cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legislation-test-"));
  const text = join(directory, "law.txt");
  mocks.save.mockResolvedValueOnce({ canceled: false, filePath: text });
  await performLegislationAction({ id: "law", action: "save" });
  expect(await readFile(text, "utf8")).toContain("第八十二条");
  const pdf = join(directory, "guide.pdf");
  mocks.save.mockResolvedValueOnce({ canceled: false, filePath: pdf });
  await performLegislationAction({ id: "guidelines", action: "save" });
  expect(
    (await readFile(pdf)).equals(
      await readFile("src/renderer/src/legislation/assets/guidelines-2025.pdf"),
    ),
  ).toBe(true);
  mocks.save.mockResolvedValueOnce({ canceled: true });
  await expect(performLegislationAction({ id: "rules", action: "save" })).resolves.toBeUndefined();
});

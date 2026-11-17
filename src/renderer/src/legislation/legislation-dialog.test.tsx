import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import law from "./assets/law.json";
import rules from "./assets/rules.json";
import { articleParagraphs, COMMON_ARTICLES } from "./common-articles";
import { LegislationDialog } from "./legislation-dialog";

const maximizeWindow = vi.fn(async () => ({ ok: true, value: {} }));
beforeEach(() => {
  vi.stubGlobal("patentApi", { application: { maximizeWindow } });
  maximizeWindow.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

test("additional documents stay in the more menu and open their own searchable text", async () => {
  const onClose = vi.fn();
  render(<LegislationDialog onClose={onClose} />);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更多法规" }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(14);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "专利优先审查管理办法" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("article", { name: "法规正文" }).textContent).toContain("2026年9月1日");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "优先审查" } });
  expect(screen.getByRole("status").textContent).toContain("处匹配");
  fireEvent.click(screen.getByRole("button", { name: "更多法规" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

test("places maximize beside close and maximizes the application before expanding", async () => {
  render(<LegislationDialog onClose={() => {}} />);
  const maximize = screen.getByRole("button", { name: "最大化阅读" });
  const close = screen.getByRole("button", { name: "关闭专利法律法规" });
  expect(maximize.parentElement).toBe(close.parentElement);
  expect(maximize.textContent).toBe("");
  expect(maximize.querySelector("svg rect")).not.toBeNull();
  fireEvent.click(maximize);
  await screen.findByRole("button", { name: "还原窗口" });
  expect(screen.getByRole("button", { name: "还原窗口" }).querySelector("svg path")).not.toBeNull();
  expect(maximizeWindow).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "还原窗口" }));
  expect(maximizeWindow).toHaveBeenCalledOnce();
});

test("find shortcut works from header controls and selects the existing query", () => {
  render(<LegislationDialog onClose={() => {}} />);
  const input = screen.getByRole("searchbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "创造性" } });
  const header = screen.getByRole("button", { name: "最大化阅读" });
  header.focus();
  fireEvent.keyDown(header, { key: "f", ctrlKey: true });
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "实施细则" }));
  expect(screen.queryByRole("button", { name: "查找（Ctrl+F）" })).toBeNull();
  header.focus();
  fireEvent.keyDown(header, { key: "f", ctrlKey: true });
  expect(document.activeElement).toBe(input);
});

test("selected law text copies via clipboard IPC and the guidelines PDF stays untouched", async () => {
  const writeText = vi.fn(async () => ({ ok: true as const, value: undefined }));
  vi.stubGlobal("patentApi", { application: { maximizeWindow }, clipboard: { writeText } });
  const selected = vi.spyOn(window, "getSelection");
  const selection = (text: string) =>
    selected.mockReturnValue({ toString: () => text } as Selection);
  try {
    selection("第二十二条　授予专利权的发明和实用新型，应当具备新颖性。");
    render(<LegislationDialog onClose={() => {}} />);
    fireEvent.keyDown(screen.getByLabelText("法规正文"), { key: "c", ctrlKey: true });
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "第二十二条　授予专利权的发明和实用新型，应当具备新颖性。",
      ),
    );
    selection("");
    fireEvent.keyDown(screen.getByLabelText("法规正文"), { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "审查指南" }));
    selection("指南文本");
    fireEvent.keyDown(screen.getByLabelText("法规阅读器"), { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledTimes(1);
  } finally {
    selected.mockRestore();
  }
});

test("common articles display official text and navigate to the corresponding law", () => {
  render(<LegislationDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "常用法条" }));
  expect(screen.getByText("新颖性、创造性与实用性")).toBeDefined();
  const card = screen.getByText("新颖性、创造性与实用性").closest("section");
  expect(
    Array.from(card?.querySelectorAll(".legislation-common__badge") ?? []).map(
      (node) => node.textContent,
    ),
  ).toEqual(["22.2", "22.3", "22.4"]);
  expect(screen.getByText("26.3")).toBeDefined();
  expect(screen.getByText("57.3")).toBeDefined();
  expect(card?.querySelector("details")?.open).toBe(true);
  expect(screen.queryByText(/适用提示/)).toBeNull();
  expect(screen.getByText(/非引用频率排名/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "查看原文：专利法第二十二条" }));
  expect(
    screen.getByLabelText("法规正文").querySelector('[data-article-target="true"]')?.textContent,
  ).toMatch(/^第二十二条/);
  fireEvent.click(screen.getByRole("button", { name: "常用法条" }));
  fireEvent.click(screen.getByRole("button", { name: "查看原文：实施细则第二十五条" }));
  expect(
    screen.getByLabelText("法规正文").querySelector('[data-article-target="true"]')?.textContent,
  ).toMatch(/^第二十五条/);
});

test("all curated references resolve to a complete single article", () => {
  for (const item of COMMON_ARTICLES) {
    const paragraphs = articleParagraphs(item.document, item.article);
    expect(paragraphs[0]?.startsWith(`${item.article}　`)).toBe(true);
    expect(paragraphs.slice(1).some((p) => /^第[零一二三四五六七八九十百]+[条章]/.test(p))).toBe(
      false,
    );
  }
  expect(articleParagraphs("rules", "第二十五条").at(-1)).toContain(
    "不得作为另一项多项从属权利要求的基础",
  );
});

test("bundles complete official law and implementing rules", () => {
  expect(law.paragraphs.filter((p) => /^第[一二三四五六七八九十百]+条/.test(p))).toHaveLength(82);
  expect(rules.paragraphs.filter((p) => /^第[零一二三四五六七八九十百]+条/.test(p))).toHaveLength(
    149,
  );
  expect(law.paragraphs.at(-1)).toMatch(/^第八十二条/);
  expect(rules.paragraphs.at(-1)).toMatch(/^第一百四十九条/);
});

test("reader pointer selection does not bubble into menu focus preservation", () => {
  const preserve = vi.fn((event) => event.preventDefault());
  render(
    <div onPointerDown={preserve}>
      <LegislationDialog onClose={() => {}} />
    </div>,
  );
  fireEvent.pointerDown(screen.getByLabelText("法规正文"));
  fireEvent.click(screen.getByRole("button", { name: "常用法条" }));
  fireEvent.pointerDown(screen.getByText("22.2"));
  expect(preserve).not.toHaveBeenCalled();
});

test("searches literal text, switches laws, and supports closing", async () => {
  const close = vi.fn();
  render(<LegislationDialog onClose={close} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "专利权" } });
  expect(document.querySelectorAll("mark").length).toBeGreaterThan(20);
  expect(screen.getByRole("status").closest(".legislation-reader__toolbar")).not.toBeNull();
  expect(document.querySelector(".legislation-reader__text-area [role=status]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下一处" }));
  expect(screen.getByRole("status").textContent).toMatch(/^2 \//);
  fireEvent.click(screen.getByRole("button", { name: "专利法" }));
  expect(screen.getByRole("status").textContent).toMatch(/^2 \//);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "[.*]" } });
  expect(screen.getByRole("status").textContent).toBe("无匹配结果");
  fireEvent.click(screen.getByRole("button", { name: "实施细则" }));
  expect(screen.getByLabelText("法规正文").textContent).toContain("第一百四十九条");
  fireEvent.click(screen.getByRole("button", { name: "最大化阅读" }));
  expect(await screen.findByRole("button", { name: "还原窗口" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "保存副本" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("保存副本失败"));
  fireEvent.click(screen.getByRole("button", { name: "关闭专利法律法规" }));
  expect(close).toHaveBeenCalledOnce();
});

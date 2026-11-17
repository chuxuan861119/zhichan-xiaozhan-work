import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "../extensions";
import { inspectTableSelection } from "./table-selection";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const documentContent = (editor: Editor) =>
  JSON.parse(
    JSON.stringify(editor.getJSON(), (key, value) => (key === "nodeId" ? undefined : value)),
  );

function setup() {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createPatentExtensions(),
    content:
      '<p>前文</p><table><tr><td colwidth="100">甲</td><td colwidth="100">乙</td></tr><tr><td colwidth="100">丙</td><td colwidth="100">丁</td></tr></table>',
  });
  cleanups.push(() => {
    editor.destroy();
    element.remove();
  });
  editor.view.dispatch(editor.state.tr);
  const rect = (x: number, y: number, width: number, height: number) =>
    new DOMRect(x, y, width, height);
  const table = editor.view.dom.querySelector("table");
  if (!table) throw new Error("Missing fixture table");
  table.getBoundingClientRect = () => rect(100, 100, 200, 100);
  [...table.rows].forEach((row, r) => {
    [...row.cells].forEach((cell, c) => {
      cell.getBoundingClientRect = () => rect(100 + c * 100, 100 + r * 50, 100, 50);
    });
  });
  return { editor, element };
}

test.each([
  [80, 100, "插入行", ["", "甲乙", "丙丁"]],
  [100, 80, "插入列", ["甲乙", "丙丁"]],
  [80, 150, "插入行", ["甲乙", "", "丙丁"]],
  [200, 80, "插入列", ["甲乙", "丙丁"]],
  [80, 200, "插入行", ["甲乙", "丙丁", ""]],
  [300, 80, "插入列", ["甲乙", "丙丁"]],
] as const)(
  "hover insertion at %s,%s inserts at the boundary and supports undo",
  (x, y, label, rows) => {
    const { editor, element } = setup();
    const before = documentContent(editor);
    editor.view.dom.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }),
    );
    const button = document.querySelector<HTMLButtonElement>(".table-insert-handle");
    expect(button).not.toBeNull();
    expect(button?.hidden).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe(label);
    expect(label === "插入行" ? button?.style.left : button?.style.top).toBe("92px");
    const guide = document.querySelector<HTMLElement>(".table-insert-guide");
    expect(label === "插入行" ? guide?.style.height : guide?.style.width).toBe("2px");
    expect(guide?.dataset.axis).toBe(label === "插入行" ? "row" : "column");
    button?.click();
    const table = editor.view.dom.querySelector("table");
    if (!table) throw new Error("Missing fixture table");
    expect([...table.rows].map((row) => row.textContent)).toEqual(rows);
    expect(inspectTableSelection(editor)).toMatchObject({
      kind: label === "插入行" ? "row" : "column",
      selectedCellCount: 2,
      ...(label === "插入行"
        ? { selectedRowIndexes: [(y - 100) / 50] }
        : { selectedColumnIndexes: [(x - 100) / 100] }),
    });
    if (label === "插入列") {
      expect(table.rows[0]?.cells).toHaveLength(3);
      expect(table.rows[0]?.cells[x === 100 ? 0 : x === 200 ? 1 : 2]?.textContent).toBe("");
    }
    expect(editor.commands.undo()).toBe(true);
    expect(documentContent(editor)).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    editor.destroy();
    element.remove();
    expect(document.querySelector(".table-insert-handle")).toBeNull();
  },
);

test("does not show insertion controls inside cells or during a drag", () => {
  const { editor, element } = setup();
  for (const [x, y, buttons] of [
    [150, 125, 0],
    [80, 150, 1],
  ] as const) {
    editor.view.dom.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y, buttons }),
    );
    expect(document.querySelector<HTMLButtonElement>(".table-insert-handle")?.hidden).toBe(true);
  }
  editor.destroy();
  element.remove();
});

test("keeps the row insertion handle available for repeated clicks without mouse movement", () => {
  const { editor } = setup();
  editor.view.dom.dispatchEvent(
    new MouseEvent("mousemove", {
      bubbles: true,
      clientX: 80,
      clientY: 150,
    }),
  );
  const button = document.querySelector<HTMLButtonElement>(".table-insert-handle");
  const guide = document.querySelector<HTMLElement>(".table-insert-guide");
  expect(button?.hidden).toBe(false);

  button?.click();
  expect(editor.view.dom.querySelectorAll("tr")).toHaveLength(3);
  expect(button?.hidden).toBe(false);
  expect(guide?.hidden).toBe(false);

  button?.click();
  expect(editor.view.dom.querySelectorAll("tr")).toHaveLength(4);
  expect(button?.hidden).toBe(false);
  expect(guide?.hidden).toBe(false);
});

test.each(["add-row-before", "add-row-after", "add-column-before", "add-column-after"])(
  "rail preview %s leaves the document and selection unchanged",
  (command) => {
    const { editor } = setup();
    let firstCell = 0;
    editor.state.doc.descendants((node, pos) => {
      if (!firstCell && node.type.name === "tableCell") firstCell = pos;
    });
    editor.commands.setTextSelection(firstCell + 2);
    const doc = editor.getJSON();
    const selection = editor.state.selection.toJSON();
    editor.view.dom.dispatchEvent(new CustomEvent("table-insertion-preview", { detail: command }));
    const guide = document.querySelector<HTMLElement>(".table-insert-guide");
    expect(guide?.hidden).toBe(false);
    expect(guide?.dataset.axis).toBe(command.includes("row") ? "row" : "column");
    expect(document.querySelector<HTMLButtonElement>(".table-insert-handle")?.hidden).toBe(true);
    expect(editor.getJSON()).toEqual(doc);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    editor.view.dom.dispatchEvent(new CustomEvent("table-insertion-preview", { detail: null }));
    expect(guide?.hidden).toBe(true);
  },
);

test.each(["scroll", "Escape", "document", "readonly"])("hides stale targets on %s", (kind) => {
  const { editor } = setup();
  const button = document.querySelector<HTMLButtonElement>(".table-insert-handle");
  const hover = () =>
    editor.view.dom.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: 80,
        clientY: 150,
      }),
    );
  hover();
  expect(button?.hidden).toBe(false);
  if (kind === "scroll") document.dispatchEvent(new Event("scroll"));
  if (kind === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  if (kind === "document") editor.commands.insertContent("新文字");
  if (kind === "readonly") editor.setEditable(false);
  expect(button?.hidden).toBe(true);
  if (kind === "readonly") {
    hover();
    expect(button?.hidden).toBe(true);
  }
});

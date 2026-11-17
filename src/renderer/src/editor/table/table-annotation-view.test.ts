import { Editor } from "@tiptap/core";
import { vi } from "vitest";
import { createPatentExtensions } from "../extensions";

test.each([14, 18])("annotations use 12pt without altering %spt cell text", (size) => {
  const element = document.createElement("div");
  const editor = new Editor({
    element,
    extensions: createPatentExtensions(),
    content: `<table data-table-name-enabled="true" data-table-name="实验结果" data-table-note-enabled="true" data-table-note="单位：秒"><tr><td><p data-default-font-size-pt="${size}">单元格正文</p></td></tr></table><p></p>`,
  });
  try {
    const annotations = element.querySelectorAll<HTMLElement>(".table-annotation");
    expect(annotations).toHaveLength(2);
    for (const annotation of annotations) expect(annotation.style.fontSize).toBe("12pt");
    expect(element.querySelector<HTMLElement>("td p")?.style.fontSize).toBe(`${size}pt`);
    const before = editor.getJSON();
    editor.commands.setTextSelection(4);
    expect(editor.getJSON()).toEqual(before);
    for (const annotation of annotations) expect(annotation.style.fontSize).toBe("12pt");
  } finally {
    editor.destroy();
  }
});

test.each([false, true])("does not measure inactive annotation inputs (enabled=%s)", (enabled) => {
  const height = vi.spyOn(Element.prototype, "scrollHeight", "get");
  const element = document.createElement("div");
  const editor = new Editor({
    element,
    extensions: createPatentExtensions(),
    content: `<table data-table-name-enabled="${enabled}" data-table-name="实验结果"><tr><td><p>数据</p></td></tr></table><p>正文</p>`,
  });
  try {
    height.mockClear();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("新增正文");
    expect(height).not.toHaveBeenCalled();
  } finally {
    editor.destroy();
    height.mockRestore();
  }
});

test("leaves unchanged table annotation DOM alone when typing outside the table", () => {
  const element = document.createElement("div");
  const editor = new Editor({
    element,
    extensions: createPatentExtensions(),
    content:
      '<table data-table-name-enabled="true" data-table-name="实验结果"><tr><td><p>数据</p></td></tr></table><p>正文</p>',
  });
  const observer = new MutationObserver(() => {});
  for (const annotation of element.querySelectorAll(".table-annotation"))
    observer.observe(annotation, { subtree: true, attributes: true, childList: true });
  try {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("新增正文");
    expect(observer.takeRecords()).toHaveLength(0);
  } finally {
    observer.disconnect();
    editor.destroy();
  }
});

test("sizes an annotation immediately when its editor is opened", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createPatentExtensions(),
    content:
      '<table data-table-name-enabled="true" data-table-name="实验结果"><tr><td><p>数据</p></td></tr></table>',
  });
  try {
    const input = element.querySelector<HTMLTextAreaElement>(".table-annotation--name textarea")!;
    Object.defineProperty(input, "scrollHeight", { configurable: true, get: () => 72 });
    element.querySelector<HTMLElement>(".table-annotation--name .table-annotation__text")!.click();
    expect(input.style.height).toBe("72px");
    expect(input.value).toBe("实验结果");
  } finally {
    editor.destroy();
    element.remove();
  }
});

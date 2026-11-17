import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { createBlankDocument } from "../../../../shared/document/defaults";
import { createPatentExtensions } from "../extensions";
import { tiptapToCanonical } from "../model-adapter";
import { sanitizePastedHtml } from "../paste-sanitizer";

function textPosition(e: Editor, text: string): number {
  let result = -1;
  e.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) result = pos;
  });
  if (result < 0) throw new Error(`Missing text: ${text}`);
  return result;
}

function selectText(e: Editor, text: string) {
  const from = textPosition(e, text);
  e.commands.setTextSelection({ from, to: from + text.length });
}

async function create(html: string) {
  const e = new Editor({
    element: document.createElement("div"),
    extensions: createPatentExtensions(),
    content: html,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return e;
}
test("Tab cannot create an unsupported nested list", async () => {
  const e = await create("<ol><li><p>甲</p></li><li><p>乙</p></li></ol>");
  let pos = 0;
  e.state.doc.descendants((n, p) => {
    if (n.text === "乙") pos = p;
  });
  e.commands.setTextSelection(pos);
  e.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
  expect(e.getJSON().content?.[0]?.content).toHaveLength(2);
  expect(e.commands.sinkListItem("listItem")).toBe(false);
  e.destroy();
});

test.each(["bulletList", "orderedList"])(
  "%s supports editing, undo/redo, split and lift",
  async (type) => {
    const e = await create('<p data-paragraph-indent-mm="9.88">甲乙</p>');
    e.commands.setTextSelection(2);
    e.commands.toggleList(type, "listItem");
    e.commands.insertContent("新");
    e.commands.splitListItem("listItem");
    const split = e.getJSON();
    expect(split.content?.[0]?.content).toHaveLength(2);
    expect(e.commands.undo()).toBe(true);
    expect(e.commands.redo()).toBe(true);
    expect(e.getJSON()).toEqual(split);
    e.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
    );
    expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
    e.commands.liftListItem("listItem");
    expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
    e.destroy();
  },
);

test("copying a later item retains its original number; partial text excludes unselected words", async () => {
  const e = await create('<ol start="3"><li><p>甲乙</p></li><li><p>丙丁</p></li></ol>');
  let pos = 0;
  e.state.doc.descendants((n, p) => {
    if (n.text === "丙丁") pos = p;
  });
  e.commands.setTextSelection({ from: pos, to: pos + 2 });
  expect(e.view.serializeForClipboard(e.state.selection.content()).text).toBe("4. 丙丁");
  e.commands.setTextSelection({ from: pos + 1, to: pos + 2 });
  expect(e.view.serializeForClipboard(e.state.selection.content()).text).toBe("丁");
  e.destroy();
});
test("nested paste keeps all text in document order as flat list items and retains start", async () => {
  const html = sanitizePastedHtml(
    '<ol start="3"><li><p>甲</p><ul><li><p>子项</p></li></ul><p>后文</p></li><li><p>乙</p></li></ol>',
  );
  const e = await create(html);
  expect(e.getJSON().content?.[0]?.attrs?.start).toBe(3);
  expect(e.getJSON().content?.[0]?.content).toHaveLength(4);
  expect(e.state.doc.textContent).toBe("甲子项后文乙");
  expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
  e.destroy();
});
test.each([
  ['ol start="3"', "ol", "3. 甲\n4. 乙"],
  ["ul", "ul", "• 甲\n• 乙"],
])("plain copy keeps markers without extra blank lines: %s", async (open, close, expected) => {
  const e = await create(`<${open}><li><p>甲</p></li><li><p>乙</p></li></${close}>`);
  e.commands.selectAll();
  expect(e.view.serializeForClipboard(e.state.selection.content()).text.trim()).toBe(expected);
  e.commands.setTextSelection({ from: 3, to: 4 });
  expect(e.view.serializeForClipboard(e.state.selection.content()).text).toContain("甲");
  e.destroy();
});

test.each(["0", "-1", "NaN", "1000001"])(
  "invalid pasted start %s falls back to one",
  async (start) => {
    const e = await create(sanitizePastedHtml(`<ol start="${start}"><li><p>甲</p></li></ol>`));
    expect(e.getJSON().content?.[0]?.attrs?.start).toBe(1);
    expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
    e.destroy();
  },
);

test.each(["bulletList", "orderedList"])(
  "removing a middle %s item preserves valid IDs and the remaining numbering",
  async (type) => {
    const tag = type === "orderedList" ? "ol" : "ul";
    const e = await create(
      `<${tag}><li><p>甲</p></li><li><p>乙</p></li><li><p>丙</p></li></${tag}>`,
    );
    selectText(e, "乙");
    const before = e.getJSON();
    expect(e.commands.toggleList(type, "listItem")).toBe(true);
    const after = e.getJSON();
    expect(after.content?.slice(0, 3).map((node) => node.type)).toEqual([type, "paragraph", type]);
    expect(tiptapToCanonical(after, createBlankDocument("测试")).ok).toBe(true);
    if (type === "orderedList") expect(after.content?.[2]?.attrs?.start).toBe(3);
    expect(e.state.doc.textContent).toBe("甲乙丙");
    expect(e.commands.undo()).toBe(true);
    expect(e.getJSON()).toEqual(before);
    expect(e.commands.redo()).toBe(true);
    expect(e.getJSON()).toEqual(after);
    e.destroy();
  },
);

test.each(["bulletList", "orderedList"])(
  "switching only the middle %s item leaves unselected items unchanged",
  async (type) => {
    const tag = type === "orderedList" ? 'ol start="3"' : "ul";
    const close = type === "orderedList" ? "ol" : "ul";
    const other = type === "orderedList" ? "bulletList" : "orderedList";
    const e = await create(
      `<${tag}><li><p>甲</p></li><li><p><strong>乙</strong></p></li><li><p>丙</p></li></${close}>`,
    );
    selectText(e, "乙");
    const before = e.getJSON();
    expect(e.commands.toggleList(other, "listItem")).toBe(true);
    const after = e.getJSON();
    expect(after.content?.slice(0, 3).map((node) => node.type)).toEqual([type, other, type]);
    expect(after.content?.[0]?.content).toEqual(before.content?.[0]?.content?.slice(0, 1));
    expect(after.content?.[2]?.content).toEqual(before.content?.[0]?.content?.slice(2));
    expect(
      e.state.doc
        .child(1)
        .child(0)
        .child(0)
        .firstChild?.marks.map((mark) => mark.type.name),
    ).toEqual(["bold"]);
    if (type === "orderedList") {
      expect(after.content?.[0]?.attrs?.start).toBe(3);
      expect(after.content?.[2]?.attrs?.start).toBe(5);
    }
    expect(tiptapToCanonical(after, createBlankDocument("测试")).ok).toBe(true);
    expect(e.state.doc.textBetween(e.state.selection.from, e.state.selection.to)).toBe("乙");
    e.destroy();
  },
);

test.each(["bulletList", "orderedList"])(
  "a failed %s command inside a table does not clear paragraph formatting",
  async (type) => {
    const e = await create(
      "<table><tbody><tr><td><p>甲</p></td><td><p>乙</p></td></tr></tbody></table>",
    );
    selectText(e, "乙");
    e.commands.updateAttributes("paragraph", {
      textAlign: "right",
      lineHeight: 2,
      defaultFontSizePt: 18,
      spaceAfterPt: 6,
    });
    const before = e.getJSON();
    expect(e.can().toggleList(type, "listItem")).toBe(false);
    expect(e.commands.toggleList(type, "listItem")).toBe(false);
    expect(e.getJSON()).toEqual(before);
    e.commands.selectAll();
    expect(e.commands.toggleList(type, "listItem")).toBe(false);
    expect(e.getJSON()).toEqual(before);
    e.destroy();
  },
);

test("HTML copying later ordered items preserves their displayed numbers", async () => {
  const e = await create(
    '<ol start="3"><li><p>甲乙</p></li><li><p>丙丁</p></li><li><p>戊己</p></li></ol>',
  );
  e.commands.setTextSelection({ from: textPosition(e, "丙丁"), to: textPosition(e, "戊己") + 2 });
  const before = e.getJSON();
  const copied = e.view.serializeForClipboard(e.state.selection.content());
  expect(copied.text).toBe("4. 丙丁\n5. 戊己");
  expect(copied.dom.querySelector("ol")?.getAttribute("start")).toBe("4");
  expect(e.getJSON()).toEqual(before);
  const target = await create(sanitizePastedHtml(copied.dom.innerHTML));
  expect(target.getJSON().content?.[0]?.attrs?.start).toBe(4);
  expect(target.state.doc.textContent).toBe("丙丁戊己");
  expect(tiptapToCanonical(target.getJSON(), createBlankDocument("测试")).ok).toBe(true);
  e.destroy();
  target.destroy();
});

test("copying a single later item keeps its ordinal in the ProseMirror clipboard context", async () => {
  const e = await create('<ol start="3"><li><p>甲乙</p></li><li><p>丙丁</p></li></ol>');
  selectText(e, "丙丁");
  const copied = e.view.serializeForClipboard(e.state.selection.content());
  const context = copied.dom.querySelector("[data-pm-slice]")?.getAttribute("data-pm-slice");
  expect(context).toContain('"start":4');
  expect(copied.text).toBe("4. 丙丁");
  expect(e.getJSON().content?.[0]?.attrs?.start).toBe(3);
  e.destroy();
});

test("select-all can remove a list despite the automatic trailing empty paragraph", async () => {
  const e = await create("<ol><li><p>甲</p></li><li><p>乙</p></li></ol>");
  e.commands.selectAll();
  expect(e.commands.toggleOrderedList()).toBe(true);
  expect(e.getJSON().content?.every((node) => node.type === "paragraph")).toBe(true);
  expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
  e.destroy();
});

test("a collapsed caret and Shift-Tab affect only their current list item", async () => {
  const e = await create(
    '<ol start="7"><li><p>甲</p></li><li><p>乙</p><p>乙续段</p></li><li><p>丙</p></li></ol>',
  );
  e.commands.setTextSelection(textPosition(e, "乙续段") + 1);
  e.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
  );
  expect(
    e
      .getJSON()
      .content?.slice(0, 4)
      .map((node) => node.type),
  ).toEqual(["orderedList", "paragraph", "paragraph", "orderedList"]);
  expect(e.getJSON().content?.[3]?.attrs?.start).toBe(9);
  expect(e.state.selection.$from.parent.textContent).toBe("乙续段");
  expect(e.state.selection.$from.parentOffset).toBe(1);
  expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
  e.destroy();
});

test("reversed selections preserve their direction and formatting when grouped into a list", async () => {
  const e = await create('<p style="text-align:right">甲乙</p><p><strong>丙丁</strong></p>');
  const anchor = textPosition(e, "丙丁") + 2;
  const head = textPosition(e, "甲乙");
  e.commands.setTextSelection({ from: anchor, to: head });
  expect(e.commands.toggleBulletList()).toBe(true);
  expect(e.getJSON().content?.[0]?.content).toHaveLength(2);
  expect(e.state.selection.anchor).toBeGreaterThan(e.state.selection.head);
  expect(e.state.doc.textBetween(e.state.selection.from, e.state.selection.to)).toBe("甲乙丙丁");
  expect(e.state.doc.child(0).child(0).child(0).attrs.textAlign).toBe("right");
  expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
  e.destroy();
});

test("list shortcuts reject a selection spanning a paragraph and a table atomically", async () => {
  const e = await create(
    "<p><strong>正文</strong></p><table><tr><td><p>表格</p></td></tr></table>",
  );
  e.commands.setTextSelection({ from: textPosition(e, "正文"), to: textPosition(e, "表格") + 2 });
  const before = e.getJSON();
  expect(e.chain().toggleOrderedList().run()).toBe(false);
  expect(e.getJSON()).toEqual(before);
  e.destroy();
});

test.each(["bulletList", "orderedList"])(
  "adding adjacent paragraphs to a %s continues the existing list",
  async (type) => {
    const e = await create("<p>甲</p><p>乙</p><p>丙</p>");
    for (const text of ["甲", "乙", "丙"]) {
      selectText(e, text);
      expect(e.commands.toggleList(type, "listItem")).toBe(true);
    }
    expect(e.getJSON().content?.filter((node) => node.type === type)).toHaveLength(1);
    expect(e.state.doc.child(0).childCount).toBe(3);
    expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
    e.destroy();
  },
);

test("re-enabling a middle numbered item reconnects its original sequence", async () => {
  const e = await create(
    '<ol start="7"><li><p>甲</p></li><li><p>乙</p></li><li><p>丙</p></li></ol>',
  );
  selectText(e, "乙");
  e.commands.toggleOrderedList();
  const lifted = e.getJSON();
  e.view.dispatch(closeHistory(e.state.tr));
  e.commands.toggleOrderedList();
  const joined = e.getJSON();
  expect(joined.content?.filter((node) => node.type === "orderedList")).toHaveLength(1);
  expect(joined.content?.[0]).toMatchObject({ attrs: { start: 7 } });
  expect(e.state.doc.child(0).childCount).toBe(3);
  expect(e.state.selection.$from.parent.textContent).toBe("乙");
  expect(tiptapToCanonical(joined, createBlankDocument("测试")).ok).toBe(true);
  expect(e.commands.undo()).toBe(true);
  expect(e.getJSON()).toEqual(lifted);
  expect(e.commands.redo()).toBe(true);
  expect(e.getJSON()).toEqual(joined);
  e.destroy();
});

test("adding an item does not merge an independent restart on the other side", async () => {
  const e = await create(
    '<ol start="7"><li><p>甲</p></li></ol><p>乙</p><ol><li><p>独立</p></li></ol>',
  );
  selectText(e, "乙");
  e.commands.toggleOrderedList();
  const lists = e.getJSON().content?.filter((node) => node.type === "orderedList");
  expect(lists).toHaveLength(2);
  expect(lists?.map((node) => node.attrs?.start)).toEqual([7, 1]);
  expect(lists?.map((node) => node.content?.length)).toEqual([2, 1]);
  e.destroy();
});

test.each(["甲", "丙"])(
  "re-enabling the %s edge item restores its original start",
  async (text) => {
    const e = await create(
      '<ol start="7"><li><p>甲</p></li><li><p>乙</p></li><li><p>丙</p></li></ol>',
    );
    selectText(e, text);
    e.commands.toggleOrderedList();
    e.commands.toggleOrderedList();
    expect(e.getJSON().content?.filter((node) => node.type === "orderedList")).toHaveLength(1);
    expect(e.state.doc.child(0).attrs.start).toBe(7);
    expect(e.state.doc.child(0).childCount).toBe(3);
    expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
    e.destroy();
  },
);

test("an explicitly requested new start is not absorbed into a preceding numbered list", async () => {
  const e = await create("<ol><li><p>甲</p></li></ol><p>乙</p>");
  selectText(e, "乙");
  e.commands.toggleList("orderedList", "listItem", false, { start: 8 });
  expect(
    e
      .getJSON()
      .content?.filter((node) => node.type === "orderedList")
      .map((node) => node.attrs?.start),
  ).toEqual([1, 8]);
  e.destroy();
});

test.each([false, true])(
  "a list selection ending at the next item's text start excludes that item (reversed=%s)",
  async (reversed) => {
    const e = await create("<ol><li><p>甲</p></li><li><p>乙</p></li><li><p>丙</p></li></ol>");
    const from = textPosition(e, "甲");
    const to = textPosition(e, "乙");
    e.commands.setTextSelection({ from: reversed ? to : from, to: reversed ? from : to });
    e.commands.toggleBulletList();
    expect(
      e
        .getJSON()
        .content?.slice(0, 2)
        .map((node) => node.type),
    ).toEqual(["bulletList", "orderedList"]);
    expect(e.state.doc.child(0).childCount).toBe(1);
    expect(e.state.doc.child(1).textContent).toBe("乙丙");
    expect(e.state.doc.child(1).attrs.start).toBe(2);
    expect(e.state.selection.anchor > e.state.selection.head).toBe(reversed);
    e.destroy();
  },
);

test.each(["bulletList", "orderedList"])(
  "select-all changes %s without turning the trailing empty paragraph into an extra item",
  async (type) => {
    const tag = type === "orderedList" ? "ol" : "ul";
    const other = type === "orderedList" ? "bulletList" : "orderedList";
    const e = await create(`<${tag}><li><p>甲</p></li><li><p>乙</p></li></${tag}>`);
    e.commands.selectAll();
    e.commands.toggleList(other, "listItem");
    expect(e.getJSON().content?.map((node) => node.type)).toEqual([other, "paragraph"]);
    expect(e.state.doc.child(0).childCount).toBe(2);
    expect(e.state.doc.lastChild?.content.size).toBe(0);
    expect(tiptapToCanonical(e.getJSON(), createBlankDocument("测试")).ok).toBe(true);
    e.destroy();
  },
);

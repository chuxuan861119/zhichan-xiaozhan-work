import type { Editor } from "@tiptap/core";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import {
  firstSupplementNumberLocation,
  scrollToSupplementNumber,
} from "./supplement-number-location";

test.each([false, true])(
  "locates the first changed keyword in document order, including claims parentheses (%s)",
  (claims) => {
    const before = createBlankPatent({ patentType: "invention", name: "位置测试" }).books[0]
      ?.document;
    if (!before) throw new Error("fixture");
    const paragraph = before.content.find((block) => block.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [{ type: "text", text: "前文箱体，连接杆", marks: [] }];
    const after = structuredClone(before);
    const changed = after.content.find((block) => block.id === paragraph.id);
    if (changed?.type !== "paragraph") throw new Error("fixture");
    const text = claims ? "前文箱体(2)，连接杆(1)" : "前文箱体2，连接杆1";
    changed.content = [{ type: "text", text, marks: [] }];
    expect(firstSupplementNumberLocation(before, after, ["连接杆", "箱体"])).toEqual({
      blockId: paragraph.id,
      offset: 2,
      text,
    });
    expect(firstSupplementNumberLocation(after, after, ["箱体"])).toBeNull();
  },
);

test("smooth-scrolls only the owning workspace to the upper part after the new text renders", () => {
  const workspace = document.createElement("div");
  workspace.className = "editor-workspace";
  const dom = document.createElement("div");
  workspace.append(dom);
  workspace.getBoundingClientRect = () => ({ top: 100, height: 600 }) as DOMRect;
  workspace.scrollBy = vi.fn();
  let text = "箱体";
  const editor = {
    view: { dom, coordsAtPos: vi.fn(() => ({ top: 900 })) },
    state: {
      doc: {
        descendants: (visit: (node: unknown, pos: number) => void) =>
          visit({ attrs: { nodeId: "p1" }, content: { size: 3 }, textBetween: () => text }, 10),
      },
    },
  } as unknown as Editor;
  const location = { blockId: "p1", offset: 0, text: "箱体1" };
  expect(scrollToSupplementNumber(editor, location)).toBe(false);
  expect(workspace.scrollBy).not.toHaveBeenCalled();
  text = "箱体1";
  expect(scrollToSupplementNumber(editor, location)).toBe(true);
  expect(editor.view.coordsAtPos).toHaveBeenCalledWith(11);
  expect(workspace.scrollBy).toHaveBeenCalledWith({ top: 632, behavior: "smooth" });
});

import { fireEvent } from "@testing-library/react";
import { installTabletTouchInput } from "./tablet-input";

function touch(target: Element, type: string, id = 1, y = 100) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType: "touch", pointerId: id, clientX: 10, clientY: y });
  fireEvent(target, event);
}

describe("tablet touch input intent", () => {
  let dispose: () => void;
  beforeEach(() => {
    document.documentElement.dataset.deviceForm = "tablet";
    dispose = installTabletTouchInput();
  });
  afterEach(() => {
    dispose();
    document.body.replaceChildren();
    delete document.documentElement.dataset.deviceForm;
  });
  test.each(["input", "textarea", "div"])(
    "%s enables input only after a tap, never during a scroll",
    (tag) => {
      const field = document.createElement(tag);
      if (tag === "div") {
        field.setAttribute("contenteditable", "true");
        field.setAttribute("data-patent-editor-id", "description");
        field.tabIndex = -1;
        field.inputMode = "none";
      }
      document.body.append(field);
      const focus = vi.spyOn(field, "focus");
      touch(field, "pointerdown");
      expect(field.inputMode).toBe("none");
      touch(field, "pointermove", 1, 130);
      touch(field, "pointerup", 1, 130);
      expect(focus).not.toHaveBeenCalled();
      touch(field, "pointerdown");
      touch(field, "pointerup");
      expect(field.inputMode).not.toBe("none");
      expect(document.activeElement).toBe(field);
    },
  );
  test.each(["pointercancel", "multitouch", "move-back", "release-away"])(
    "does not enter typing after %s",
    (scenario) => {
      const field = document.createElement("input");
      document.body.append(field);
      touch(field, "pointerdown");
      if (scenario === "pointercancel") touch(field, "pointercancel");
      if (scenario === "multitouch") touch(field, "pointerdown", 2);
      if (scenario === "move-back") touch(field, "pointermove", 1, 140);
      touch(field, "pointerup", 1, scenario === "release-away" ? 140 : 100);
      expect(document.activeElement).not.toBe(field);
    },
  );
  test("preserves numeric mode and leaves desktop and mouse input alone", () => {
    const field = document.createElement("input");
    field.inputMode = "decimal";
    document.body.append(field);
    touch(field, "pointerdown");
    touch(field, "pointerup");
    expect(field.inputMode).toBe("decimal");
    field.blur();
    fireEvent.pointerDown(field, { pointerType: "mouse" });
    expect(field.inputMode).toBe("decimal");
    delete document.documentElement.dataset.deviceForm;
    touch(field, "pointerdown");
    expect(field.inputMode).toBe("decimal");
  });
  test.each(["field", "page"])(
    "scrolling from %s ends an existing input session, a tap does not",
    (surface) => {
      const field = document.createElement("textarea");
      const page = document.createElement("div");
      document.body.append(field, page);
      field.value = "保留未保存的文字";
      field.focus();
      const target = surface === "field" ? field : page;
      touch(target, "pointerdown");
      touch(target, "pointerup");
      expect(document.activeElement).toBe(field);
      touch(target, "pointerdown");
      touch(target, "pointermove", 1, 130);
      expect(document.activeElement).not.toBe(field);
      touch(target, "pointerup", 1, 130);
      expect(document.activeElement).not.toBe(field);
      expect(field.value).toBe("保留未保存的文字");
    },
  );
});

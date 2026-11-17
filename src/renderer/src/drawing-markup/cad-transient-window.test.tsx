import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadTransientWindow } from "./cad-transient-window";

afterEach(cleanup);

test("settings live in the canvas host without trapping focus or closing on outside clicks", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const close = vi.fn();
  const view = render(
    <CadTransientWindow target={host} open title="正多边形" onClose={close}>
      <label>
        边数
        <input type="number" defaultValue="5" />
      </label>
    </CadTransientWindow>,
  );
  const dialog = screen.getByRole("dialog", { name: "正多边形设置" });
  expect(host.contains(dialog)).toBe(true);
  expect(view.container.contains(dialog)).toBe(false);
  expect(dialog.getAttribute("aria-modal")).toBe("false");
  expect(
    dialog.querySelector(".cad-transient-window__body > .cad-transient-window__header"),
  ).not.toBeNull();
  fireEvent.pointerDown(document.body);
  expect(close).not.toHaveBeenCalled();
  const field = screen.getByRole("spinbutton");
  field.focus();
  view.rerender(
    <CadTransientWindow target={host} open title="正多边形" onClose={close}>
      <label>
        边数
        <input type="number" defaultValue="5" />
      </label>
    </CadTransientWindow>,
  );
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: "Escape", isComposing: true });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
  expect(close).toHaveBeenCalledTimes(2);
  view.unmount();
  host.remove();
});

test("a missing canvas host does not put settings back in the function rail", () => {
  const view = render(
    <CadTransientWindow target={null} open title="填充" onClose={() => {}}>
      <input aria-label="填充比例" />
    </CadTransientWindow>,
  );
  expect(view.container.childElementCount).toBe(0);
});

test("only real temporary controls open the palette, not empty conditional fragments", () => {
  const target = document.createElement("div");
  document.body.append(target);
  const view = render(
    <CadTransientWindow target={target} title="绘图" onClose={() => {}}>
      <>
        {false}
        {null}
      </>
    </CadTransientWindow>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(
    <CadTransientWindow target={target} title="绘图" onClose={() => {}}>
      <>
        <button type="button">应用</button>
      </>
    </CadTransientWindow>,
  );
  expect(screen.getByRole("dialog", { name: "绘图设置" })).toBeTruthy();
  view.unmount();
  target.remove();
});

import { ActiveEditorSessionContext, EditorSessionScope } from "../shared/editor-session-scope";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Circle } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { CadToolMenu } from "./cad-tool-menu";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const choices = [
  { id: "circle", label: "圆心、半径", tool: "circle", Icon: Circle },
  { id: "circle.2p", label: "两点", tool: "circle", Icon: Circle },
];
test("split menu remembers its checked item but the idle main button invokes the default tool", () => {
  const choose = vi.fn(),
    focusCanvas = vi.fn();
  const props = { name: "圆", choices, active: false, disabled: false, choose, focusCanvas };
  const view = render(<CadToolMenu {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "圆选项" }));
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "圆心、半径" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "两点" }));
  fireEvent.click(document.activeElement!);
  expect(choose).toHaveBeenLastCalledWith(choices[1]);
  view.unmount();
  render(<CadToolMenu {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "圆选项" }));
  expect(screen.getByRole("menuitemradio", { name: "两点" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.pointerDown(document.body);
  fireEvent.click(screen.getByRole("button", { name: "圆" }));
  expect(choose).toHaveBeenLastCalledWith(choices[0]);
  fireEvent.click(screen.getByRole("button", { name: "圆选项" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(choose).toHaveBeenCalledTimes(2);
  expect(focusCanvas).toHaveBeenCalledTimes(3);
});
test("outside press and disabling close the menu without selecting", () => {
  const choose = vi.fn();
  const props = {
    name: "圆",
    choices,
    active: false,
    disabled: false,
    choose,
    focusCanvas: vi.fn(),
  };
  const view = render(<CadToolMenu {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "圆选项" }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "圆选项" }));
  view.rerender(<CadToolMenu {...props} disabled />);
  view.rerender(<CadToolMenu {...props} />);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(choose).not.toHaveBeenCalled();
});

test("rail scroll repositions an open tool menu instead of dismissing it", () => {
  render(
    <CadToolMenu
      name="圆"
      choices={choices}
      active={false}
      disabled={false}
      choose={vi.fn()}
      focusCanvas={vi.fn()}
    />,
  );
  const arrow = screen.getByRole("button", { name: "圆选项" });
  const bounds = vi.spyOn(arrow, "getBoundingClientRect");
  bounds.mockReturnValue({ right: 200, bottom: 100 } as DOMRect);
  fireEvent.click(arrow);
  expect(screen.getByRole("menu").style.top).toBe("106px");
  bounds.mockReturnValue({ right: 200, bottom: 150 } as DOMRect);
  fireEvent.scroll(document.body);
  expect(screen.getByRole("menu").style.top).toBe("156px");
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("active choice replaces the main button only until the tool finishes or is cancelled", () => {
  const choose = vi.fn();
  const props = {
    name: "圆",
    choices,
    active: false,
    disabled: false,
    choose,
    focusCanvas: vi.fn(),
    activeChoiceId: "circle.2p",
  };
  const view = render(<CadToolMenu {...props} />);
  expect(screen.getByRole("button", { name: "圆" }).hasAttribute("title")).toBe(false);
  expect(screen.getByRole("button", { name: "圆" }).getAttribute("aria-description")).toBe(
    "圆 · 圆心、半径",
  );
  view.rerender(<CadToolMenu {...props} active />);
  fireEvent.click(screen.getByRole("button", { name: "两点" }));
  expect(choose).toHaveBeenLastCalledWith(choices[1]);
  view.rerender(<CadToolMenu {...props} active={false} />);
  fireEvent.click(screen.getByRole("button", { name: "圆" }));
  expect(choose).toHaveBeenLastCalledWith(choices[0]);
  // The parent can repeat a tool or change its method without another menu click.
  view.rerender(<CadToolMenu {...props} active activeChoiceId="circle" />);
  expect(screen.getByRole("button", { name: "圆" })).toBeTruthy();
});
test("a CAD menu cannot remain on top of another patent", () => {
  const tree = (owner: string) => (
    <ActiveEditorSessionContext.Provider value={owner}>
      <EditorSessionScope sessionId="a">
        <CadToolMenu
          name="圆"
          choices={choices}
          active={false}
          disabled={false}
          choose={vi.fn()}
          focusCanvas={vi.fn()}
        />
      </EditorSessionScope>
    </ActiveEditorSessionContext.Provider>
  );
  const view = render(tree("a"));
  fireEvent.click(screen.getByRole("button", { name: "圆选项" }));
  expect(screen.getByRole("menu")).toBeTruthy();
  view.rerender(tree("b"));
  expect(screen.queryByRole("menu")).toBeNull();
});

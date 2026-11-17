import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CadPropertiesPanel } from "./cad-properties-panel";
import type { CadcraftClient, CadScene } from "./cadcraft-client";

type Entity = CadScene["entities"][number];
const text: Entity = {
  handle: "A",
  type: "Text",
  layer: "0",
  text: "底座",
  height: 3,
  rotation: 0,
  lineweight: 0.25,
};
const circle: Entity = {
  handle: "B",
  type: "Circle",
  layer: "0",
  radius: 8,
  lineweight: 0.25,
};
function props(overrides: Partial<ComponentProps<typeof CadPropertiesPanel>> = {}) {
  return {
    client: { request: vi.fn().mockResolvedValue({ layers: [] }) } as unknown as CadcraftClient,
    entities: [text, circle],
    handles: ["A"],
    revision: 1,
    disabled: false,
    execute: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    center: [0, 0] as [number, number],
    ...overrides,
  };
}
afterEach(cleanup);

it("formats dimensions but retains standard lineweights and untouched precise fields", async () => {
  const input = props({ entities: [{ ...text, height: 3.123456, rotation: 12.8765 }] });
  render(<CadPropertiesPanel {...input} />);
  expect(screen.getByLabelText("文字高度")).toHaveProperty("value", "3.1");
  expect(screen.getByLabelText("旋转角度（°）")).toHaveProperty("value", "12.9");
  expect(screen.getByLabelText("线宽（mm）")).toHaveProperty("value", "0.25");
  fireEvent.change(screen.getByLabelText("文字内容"), { target: { value: "支架" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "应用修改" })));
  expect(input.execute).toHaveBeenCalledExactlyOnceWith("properties.set", {
    handles: ["A"],
    text: "支架",
  });
});

it("stays absent without a selection and never requests layer controls", () => {
  const input = props({ handles: [] });
  const { container } = render(<CadPropertiesPanel {...input} />);
  expect(container.childElementCount).toBe(0);
  expect(input.client.request).not.toHaveBeenCalled();
});

it("shows current supported properties as directly labelled contextual fields", () => {
  const input = props();
  render(<CadPropertiesPanel {...input} />);
  expect(screen.getByRole("heading", { name: "对象属性" })).toBeTruthy();
  expect((screen.getByLabelText("文字内容") as HTMLTextAreaElement).value).toBe("底座");
  expect((screen.getByLabelText("文字高度") as HTMLInputElement).value).toBe("3");
  expect((screen.getByLabelText("旋转角度（°）") as HTMLInputElement).value).toBe("0");
  expect((screen.getByLabelText("线宽（mm）") as HTMLInputElement).value).toBe("0.25");
  expect(screen.queryByLabelText("半径")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText(/图层|阵列|图块|属性值/)).toBeNull();
  expect(input.client.request).not.toHaveBeenCalled();
});

it("applies only changed fields to the current selected handles", async () => {
  const input = props();
  render(<CadPropertiesPanel {...input} />);
  fireEvent.change(screen.getByLabelText("文字内容"), { target: { value: "连接座" } });
  fireEvent.change(screen.getByLabelText("文字高度"), { target: { value: "4" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "应用修改" })));
  expect(input.execute).toHaveBeenCalledExactlyOnceWith("properties.set", {
    handles: ["A"],
    text: "连接座",
    height: 4,
  });
});

it("represents mixed values without replacing untouched fields", async () => {
  const input = props({
    entities: [circle, { ...circle, handle: "C", radius: 12, lineweight: 0.5 }],
    handles: ["B", "C"],
  });
  render(<CadPropertiesPanel {...input} />);
  const radius = screen.getByLabelText("半径") as HTMLInputElement;
  expect(radius.value).toBe("");
  expect(radius.placeholder).toBe("多个值");
  expect((screen.getByRole("button", { name: "应用修改" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(radius, { target: { value: "10" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "应用修改" })));
  expect(input.execute).toHaveBeenCalledExactlyOnceWith("properties.set", {
    handles: ["B", "C"],
    radius: 10,
  });
});

it("discards old drafts when selection changes before another apply", async () => {
  const input = props({ entities: [text, { ...text, handle: "C", text: "支架", height: 2 }] });
  const view = render(<CadPropertiesPanel {...input} />);
  fireEvent.change(screen.getByLabelText("文字高度"), { target: { value: "9" } });
  view.rerender(<CadPropertiesPanel {...input} handles={["C"]} />);
  expect((screen.getByLabelText("文字高度") as HTMLInputElement).value).toBe("2");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "应用修改" })));
  expect(input.execute).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("文字高度"), { target: { value: "4" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "应用修改" })));
  expect(input.execute).toHaveBeenCalledExactlyOnceWith("properties.set", {
    handles: ["C"],
    height: 4,
  });
});

it("refreshes the current values after a persisted revision changes", () => {
  const input = props();
  const view = render(<CadPropertiesPanel {...input} />);
  fireEvent.change(screen.getByLabelText("文字高度"), { target: { value: "9" } });
  view.rerender(
    <CadPropertiesPanel {...input} revision={2} entities={[{ ...text, height: 4 }, circle]} />,
  );
  expect((screen.getByLabelText("文字高度") as HTMLInputElement).value).toBe("4");
  expect((screen.getByRole("button", { name: "应用修改" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it.each(["disabled", "locked"])("does not permit property edits when %s", (reason) => {
  render(
    <CadPropertiesPanel
      {...props({
        disabled: reason === "disabled",
        entities: [{ ...text, locked: reason === "locked" }],
      })}
    />,
  );
  expect((screen.getByLabelText("文字高度") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "应用修改" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("validates changed fields and prevents a repeated apply while processing", async () => {
  let finish = () => {};
  const input = props({
    execute: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  render(<CadPropertiesPanel {...input} />);
  fireEvent.change(screen.getByLabelText("文字高度"), { target: { value: "0" } });
  expect((screen.getByRole("button", { name: "应用修改" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText("文字高度"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "应用修改" }));
  expect((screen.getByLabelText("文字高度") as HTMLInputElement).disabled).toBe(true);
  await act(async () => finish());
  expect(input.execute).toHaveBeenCalledTimes(1);
});

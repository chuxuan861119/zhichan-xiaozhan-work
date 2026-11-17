import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadSpringProperties } from "./cad-spring-properties";

afterEach(cleanup);

test("extension spring edits preserve its kind and validate room for both hooks", async () => {
  const apply = vi.fn(async () => {});
  const extension = {
    kind: "extension" as const,
    at: [0, 0] as [number, number],
    end: [82.7, 0] as [number, number],
    length: 82.7,
    width: 20,
    wire: 2.3,
    turns: 15,
    rotation: 0,
  };
  render(<CadSpringProperties spring={extension} disabled={false} apply={apply} />);
  expect(screen.getByText("拉伸弹簧设置")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("弹簧长度"), { target: { value: "40" } });
  expect(screen.getByRole("alert").textContent).toContain("挂钩");
  expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("弹簧长度"), { target: { value: "110" } });
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ ...extension, length: 110 }));
});
const spring = {
  at: [0, 0] as [number, number],
  end: [88.25349, 0] as [number, number],
  length: 88.25349,
  width: 45.1278,
  wire: 4.5321,
  turns: 7,
  rotation: 0,
};

test("spring fields display one decimal without making untouched geometry dirty", () => {
  const apply = vi.fn(async () => {});
  render(<CadSpringProperties spring={spring} disabled={false} apply={apply} />);
  expect(screen.getByLabelText("弹簧长度")).toHaveProperty("value", "88.3");
  expect(screen.getByLabelText("弹簧宽度")).toHaveProperty("value", "45.1");
  expect(screen.getByLabelText("弹簧线径")).toHaveProperty("value", "4.5");
  const length = screen.getByLabelText("弹簧长度");
  fireEvent.focus(length);
  fireEvent.blur(length);
  expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", true);
  expect(apply).not.toHaveBeenCalled();
});

test("editing turns preserves the full precision of other spring parameters", async () => {
  const apply = vi.fn(async () => {});
  render(<CadSpringProperties spring={spring} disabled={false} apply={apply} />);
  fireEvent.change(screen.getByLabelText("弹簧圈数"), { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ ...spring, turns: 8 }));
});

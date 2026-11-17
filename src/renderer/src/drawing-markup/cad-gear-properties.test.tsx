import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadGearProperties } from "./cad-gear-properties";

afterEach(cleanup);
test("gear size is concise while a tooth edit preserves its actual diameter", async () => {
  const precise = { kind: "external" as const, teeth: 20, size: 80.123456789, hole: true };
  const apply = vi.fn(async () => {});
  render(<CadGearProperties gear={precise} disabled={false} apply={apply} />);
  expect(screen.getByLabelText("齿轮大小")).toHaveProperty("value", "80.1");
  expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("齿轮齿数"), { target: { value: "24" } });
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ ...precise, teeth: 24 }));
});
const gear = { kind: "external" as const, teeth: 20, size: 80, hole: true };
test("gear properties reject invalid teeth, apply once and preserve precision until changed", async () => {
  const apply = vi.fn(async () => {});
  render(<CadGearProperties gear={gear} disabled={false} apply={apply} />);
  const button = screen.getByRole("button", { name: "应用" });
  expect(button).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("齿轮齿数"), { target: { value: "2.5" } });
  expect(button).toHaveProperty("disabled", true);
  expect(screen.getByRole("alert").textContent).toContain("整数");
  fireEvent.change(screen.getByLabelText("齿轮齿数"), { target: { value: "30" } });
  fireEvent.click(button);
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ ...gear, teeth: 30 }));
});
test.each(["rack", "internal"] as const)("%s has no irrelevant center-hole option", (kind) => {
  render(
    <CadGearProperties
      gear={{ ...gear, kind, hole: false }}
      disabled={false}
      apply={async () => {}}
    />,
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
});

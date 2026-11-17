import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadChainProperties } from "./cad-chain-properties";
import { chainPitch } from "./cad-chain-geometry";
afterEach(cleanup);
test("one-decimal display preserves original geometry and unchanged inputs cannot apply", () => {
  const apply = vi.fn();
  const chain = {
    single: false,
    at: [0, 0] as [number, number],
    end: [108.123456, 18.765432] as [number, number],
    radius: 14.12345,
    otherRadius: 10.98765,
    teeth: 23,
    otherTeeth: 17,
    hole: 2.54321,
    otherHole: 1.54321,
  };
  render(<CadChainProperties chain={chain} disabled={false} apply={apply} />);
  expect(screen.getByRole("spinbutton", { name: "左轮轮径" })).toHaveProperty("value", "28.2");
  expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("spinbutton", { name: "左轮齿数" }), {
    target: { value: "24" },
  });
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  expect(apply).toHaveBeenCalledWith(
    expect.objectContaining({
      hole: chain.hole,
      teeth: 24,
    }),
  );
  expect(chainPitch(apply.mock.calls[0]![0])).toBeCloseTo(chainPitch(chain), 10);
});
test("typing a wheel diameter links tooth count, preserves pitch and settles the achievable diameter on blur", () => {
  const apply = vi.fn();
  const chain = {
    single: false,
    at: [0, 0] as [number, number],
    end: [108, 0] as [number, number],
    radius: 14,
    teeth: 23,
    otherTeeth: 17,
    hole: 2.5,
    otherHole: 1.5,
  };
  render(<CadChainProperties chain={chain} disabled={false} apply={apply} />);
  const input = screen.getByRole("spinbutton", { name: "右轮轮径" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "84" } });
  expect(
    Number((screen.getByRole("spinbutton", { name: "右轮齿数" }) as HTMLInputElement).value),
  ).toBeGreaterThan(60);
  fireEvent.blur(input);
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  const updated = apply.mock.calls[0]![0];
  expect(2 * updated.otherRadius * Math.sin(Math.PI / updated.otherTeeth)).toBeCloseTo(
    chainPitch(chain),
    10,
  );
  expect(Number((input as HTMLInputElement).value)).toBeCloseTo(updated.otherRadius * 2, 1);
});

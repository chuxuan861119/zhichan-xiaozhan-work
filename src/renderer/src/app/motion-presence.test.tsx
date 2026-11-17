import { render, screen } from "@testing-library/react";
import { act } from "react";
import { MotionPresence } from "./motion-presence";

test("retains a closing dialog for the exit animation and then removes it", () => {
  vi.useFakeTimers();
  try {
    const { rerender } = render(
      <MotionPresence>
        <div role="dialog">设置</div>
      </MotionPresence>,
    );
    rerender(<MotionPresence>{null}</MotionPresence>);

    const retained = screen.getByText("设置").closest(".motion-presence");
    expect(retained?.getAttribute("data-motion-state")).toBe("closing");
    expect(retained?.getAttribute("aria-hidden")).toBe("true");

    act(() => vi.advanceTimersByTime(420));
    expect(screen.queryByText("设置")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("removes a dialog immediately when reduced motion is requested", () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  try {
    const { rerender } = render(
      <MotionPresence>
        <div role="dialog">设置</div>
      </MotionPresence>,
    );
    rerender(<MotionPresence>{null}</MotionPresence>);
    expect(screen.queryByText("设置")).toBeNull();
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

test("retains a panel through the fixed exit duration and cancels removal when reopened", () => {
  vi.useFakeTimers();
  try {
    const panel = <aside aria-label="侧面板">内容</aside>;
    const { rerender } = render(<MotionPresence kind="panel">{panel}</MotionPresence>);
    rerender(<MotionPresence kind="panel">{null}</MotionPresence>);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByText("内容").closest(".motion-presence")?.hasAttribute("inert")).toBe(true);
    rerender(<MotionPresence kind="panel">{panel}</MotionPresence>);
    act(() => vi.advanceTimersByTime(420));
    expect(screen.getByRole("complementary", { name: "侧面板" })).toBeDefined();
    rerender(<MotionPresence kind="panel">{null}</MotionPresence>);
    act(() => vi.advanceTimersByTime(420));
    expect(screen.queryByText("内容")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("sibling dialogs retain exits independently even while another remains open", () => {
  vi.useFakeTimers();
  try {
    const first = <section>第一弹层</section>;
    const second = <section>第二弹层</section>;
    const view = render(
      <MotionPresence>
        {first}
        {second}
      </MotionPresence>,
    );
    view.rerender(
      <MotionPresence>
        {null}
        {second}
      </MotionPresence>,
    );
    expect(screen.getByText("第一弹层").closest(".motion-presence")?.hasAttribute("inert")).toBe(
      true,
    );
    expect(screen.getByText("第二弹层").closest(".motion-presence")?.hasAttribute("inert")).toBe(
      false,
    );
    act(() => vi.advanceTimersByTime(420));
    expect(screen.queryByText("第一弹层")).toBeNull();
    view.rerender(
      <MotionPresence>
        {null}
        {null}
      </MotionPresence>,
    );
    expect(screen.getByText("第二弹层").closest(".motion-presence")?.hasAttribute("inert")).toBe(
      true,
    );
    act(() => vi.advanceTimersByTime(420));
    expect(screen.queryByText("第二弹层")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("closing model paint clears password fields immediately", () => {
  vi.useFakeTimers();
  try {
    const view = render(
      <MotionPresence clearSensitiveInputs>
        <section>
          <input type="password" value="sample-secret" readOnly />
        </section>
      </MotionPresence>,
    );
    view.rerender(<MotionPresence clearSensitiveInputs>{null}</MotionPresence>);
    expect(view.container.querySelector("section")).not.toBeNull();
    expect(view.container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
      "",
    );
    act(() => vi.advanceTimersByTime(420));
    expect(view.container.querySelector("section")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

import { act, render, screen } from "@testing-library/react";
import { TemplateViewTransition } from "./template-view-transition";

test("keeps outgoing paint across replacement, leaves new paper opaque and cleans interrupted motion", () => {
  vi.useFakeTimers();
  const original = HTMLElement.prototype.animate;
  const cancel = vi.fn();
  const animate = vi.fn().mockReturnValue({ cancel });
  HTMLElement.prototype.animate = animate;
  const view = (key: string) => (
    <TemplateViewTransition viewKey={key}>
      <section key={key} id={`page-${key}`}>
        <input aria-label="草稿" defaultValue={key} />
        <p>{key}</p>
      </section>
    </TemplateViewTransition>
  );
  const rendered = render(view("权利要求书"));
  try {
    const input = screen.getByRole("textbox", { name: "草稿" });
    rendered.rerender(view("权利要求书"));
    expect(screen.getByRole("textbox", { name: "草稿" })).toBe(input);
    expect(animate).not.toHaveBeenCalled();
    rendered.rerender(view("说明书"));
    const outgoing = rendered.container.querySelector(".template-view-transition__outgoing");
    expect(outgoing?.textContent).toBe("权利要求书");
    expect(outgoing?.querySelector("[id]")).toBeNull();
    expect(screen.getByRole("textbox", { name: "草稿" }).getAttribute("value")).toBe("说明书");
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { transform: "translateY(6px)" },
      { transform: "translateY(0)" },
    ]);
    rendered.rerender(view("空白模板"));
    expect(outgoing?.children).toHaveLength(1);
    expect(outgoing?.textContent).toBe("说明书");
    act(() => vi.advanceTimersByTime(421));
    expect(outgoing?.children).toHaveLength(0);
    expect(cancel).toHaveBeenCalledTimes(4);
  } finally {
    rendered.unmount();
    HTMLElement.prototype.animate = original;
    vi.useRealTimers();
  }
});

test("reduced motion switches immediately without retaining old paint", () => {
  document.documentElement.dataset.reducedMotion = "true";
  const rendered = render(
    <TemplateViewTransition viewKey="old">
      <p>旧页面</p>
    </TemplateViewTransition>,
  );
  try {
    rendered.rerender(
      <TemplateViewTransition viewKey="new">
        <p>新页面</p>
      </TemplateViewTransition>,
    );
    expect(rendered.container.textContent).toBe("新页面");
    expect(
      rendered.container.querySelector(".template-view-transition__outgoing")?.children,
    ).toHaveLength(0);
  } finally {
    rendered.unmount();
    delete document.documentElement.dataset.reducedMotion;
  }
});

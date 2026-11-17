import { render, screen } from "@testing-library/react";
import { SpatialView } from "./spatial-view";

test("view paint uses shared timing while preserving drafts and cancelling interrupted motion", () => {
  const original = HTMLElement.prototype.animate;
  const cancel = vi.fn();
  const animate = vi.fn().mockReturnValue({ cancel });
  HTMLElement.prototype.animate = animate;
  try {
    const view = (key: string) => (
      <SpatialView viewKey={key}>
        <section>
          <input aria-label="未保存草稿" defaultValue="保留内容" />
        </section>
      </SpatialView>
    );
    const rendered = render(view("first"));
    const draft = screen.getByLabelText("未保存草稿");
    rendered.rerender(view("second"));
    expect(screen.getByLabelText("未保存草稿")).toBe(draft);
    expect(animate).toHaveBeenLastCalledWith(expect.any(Array), {
      duration: 400,
      easing: "ease-in-out",
    });
    expect(cancel).toHaveBeenCalledOnce();
    rendered.rerender(view("second"));
    expect(animate).toHaveBeenCalledTimes(2);
    rendered.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  } finally {
    HTMLElement.prototype.animate = original;
  }
});

test("reduced motion skips paint animation", () => {
  const original = HTMLElement.prototype.animate;
  const animate = vi.fn();
  HTMLElement.prototype.animate = animate;
  document.documentElement.dataset.reducedMotion = "true";
  try {
    const rendered = render(
      <SpatialView viewKey="first">
        <section>内容</section>
      </SpatialView>,
    );
    rendered.rerender(
      <SpatialView viewKey="second">
        <section>新内容</section>
      </SpatialView>,
    );
    expect(animate).not.toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.animate = original;
    delete document.documentElement.dataset.reducedMotion;
  }
});

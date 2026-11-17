import { act, render, screen } from "@testing-library/react";
import { SpatialCollapse } from "./spatial-collapse";

afterEach(() => vi.useRealTimers());

test("moves a stack's parent gap inside the collapsing content", () => {
  const view = render(
    <SpatialCollapse open parentGap={14}>
      <input aria-label="带间距内容" />
    </SpatialCollapse>,
  );
  expect((view.container.firstElementChild as HTMLElement).style.marginBlockStart).toBe("-14px");
  expect(screen.getByLabelText("带间距内容").parentElement?.style.paddingBlockStart).toBe("14px");
});

test("can show initially open content immediately while animating later expansions", () => {
  vi.useFakeTimers();
  const view = render(
    <SpatialCollapse open animateInitial={false}>
      内容
    </SpatialCollapse>,
  );
  expect(view.container.firstElementChild?.getAttribute("data-motion")).toBe("steady");
  view.rerender(
    <SpatialCollapse open={false} animateInitial={false}>
      内容
    </SpatialCollapse>,
  );
  act(() => vi.advanceTimersByTime(420));
  expect(view.container.firstElementChild).toBeNull();
  view.rerender(
    <SpatialCollapse open animateInitial={false}>
      内容
    </SpatialCollapse>,
  );
  expect(view.container.firstElementChild?.getAttribute("data-motion")).toBe("enter");
});

test("keeps content during closing, cancels removal when reopened, and removes it after closing", () => {
  vi.useFakeTimers();
  const content = <input aria-label="草稿" defaultValue="保留内容" />;
  const view = render(<SpatialCollapse open>{content}</SpatialCollapse>);
  const input = screen.getByLabelText("草稿");
  view.rerender(<SpatialCollapse open={false}>{content}</SpatialCollapse>);
  expect(input.closest(".spatial-collapse")?.hasAttribute("inert")).toBe(true);
  act(() => vi.advanceTimersByTime(200));
  view.rerender(<SpatialCollapse open>{content}</SpatialCollapse>);
  act(() => vi.advanceTimersByTime(420));
  expect(screen.getByLabelText("草稿")).toBe(input);
  view.rerender(<SpatialCollapse open={false}>{content}</SpatialCollapse>);
  act(() => vi.advanceTimersByTime(400));
  expect(document.querySelector("input")).toBe(input);
  act(() => vi.advanceTimersByTime(20));
  expect(document.querySelector("input")).toBeNull();
});

test("keeps the last expanded content when a closing parent removes its data", () => {
  vi.useFakeTimers();
  const view = render(
    <SpatialCollapse open>
      <p>匹配详情</p>
    </SpatialCollapse>,
  );
  view.rerender(<SpatialCollapse open={false}>{null}</SpatialCollapse>);
  expect(screen.getByText("匹配详情").closest(".spatial-collapse")?.hasAttribute("inert")).toBe(
    true,
  );
  act(() => vi.advanceTimersByTime(420));
  expect(screen.queryByText("匹配详情")).toBeNull();
});

test("honors a longer exit retention without leaving closing controls interactive", () => {
  vi.useFakeTimers();
  const view = render(
    <SpatialCollapse open retentionMs={420}>
      <button type="button">批量操作</button>
    </SpatialCollapse>,
  );
  view.rerender(
    <SpatialCollapse open={false} retentionMs={420}>
      {null}
    </SpatialCollapse>,
  );
  const content = screen.getByText("批量操作");
  expect(content.closest(".spatial-collapse")?.hasAttribute("inert")).toBe(true);
  act(() => vi.advanceTimersByTime(400));
  expect(screen.queryByText("批量操作")).toBe(content);
  act(() => vi.advanceTimersByTime(20));
  expect(screen.queryByText("批量操作")).toBeNull();
});

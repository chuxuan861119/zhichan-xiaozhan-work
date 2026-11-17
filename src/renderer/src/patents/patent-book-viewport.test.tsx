import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PatentBookKind } from "../../../shared/patent/model";
import {
  PatentBookViewportProvider,
  PatentBookViewportStore,
  usePatentBookViewportRegistration,
} from "./patent-book-viewport";

function setScrollGeometry(node: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(node, "clientHeight", { configurable: true, value: clientHeight });
}

function ViewportHarness({ patentId, bookKind }: { patentId: string; bookKind: PatentBookKind }) {
  const register = usePatentBookViewportRegistration(`${patentId}:${bookKind}`);
  return <div data-testid="viewport" ref={register} />;
}

async function flushRestoreFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe("patent book viewport", () => {
  test("stores separate scroll positions per patent book", async () => {
    const store = new PatentBookViewportStore();
    const { rerender } = render(
      <PatentBookViewportProvider store={store}>
        <ViewportHarness patentId="patent-1" bookKind="description" />
      </PatentBookViewportProvider>,
    );
    const viewport = screen.getByTestId("viewport");
    setScrollGeometry(viewport, 1200, 200);
    await flushRestoreFrame();

    viewport.scrollTop = 800;
    fireEvent.scroll(viewport);
    rerender(
      <PatentBookViewportProvider store={store}>
        <ViewportHarness patentId="patent-1" bookKind="claims" />
      </PatentBookViewportProvider>,
    );
    await flushRestoreFrame();
    expect(viewport.scrollTop).toBe(0);

    viewport.scrollTop = 120;
    fireEvent.scroll(viewport);
    rerender(
      <PatentBookViewportProvider store={store}>
        <ViewportHarness patentId="patent-1" bookKind="description" />
      </PatentBookViewportProvider>,
    );
    await flushRestoreFrame();
    expect(viewport.scrollTop).toBe(800);

    rerender(
      <PatentBookViewportProvider store={store}>
        <ViewportHarness patentId="patent-1" bookKind="claims" />
      </PatentBookViewportProvider>,
    );
    await flushRestoreFrame();
    expect(viewport.scrollTop).toBe(120);
  });

  test("does not share positions between two patents", async () => {
    const store = new PatentBookViewportStore();
    const { rerender } = render(
      <PatentBookViewportProvider store={store}>
        <ViewportHarness patentId="patent-1" bookKind="description" />
      </PatentBookViewportProvider>,
    );
    const viewport = screen.getByTestId("viewport");
    setScrollGeometry(viewport, 1000, 200);
    await flushRestoreFrame();
    viewport.scrollTop = 640;
    fireEvent.scroll(viewport);

    rerender(
      <PatentBookViewportProvider store={store}>
        <ViewportHarness patentId="patent-2" bookKind="description" />
      </PatentBookViewportProvider>,
    );
    await flushRestoreFrame();
    expect(viewport.scrollTop).toBe(0);
  });

  test("clamps restored positions when content becomes shorter", async () => {
    const store = new PatentBookViewportStore();
    store.write("patent-1:description", 900);
    render(
      <PatentBookViewportProvider store={store}>
        <ViewportHarness patentId="patent-1" bookKind="description" />
      </PatentBookViewportProvider>,
    );
    const viewport = screen.getByTestId("viewport");
    setScrollGeometry(viewport, 400, 150);

    await flushRestoreFrame();

    expect(viewport.scrollTop).toBe(250);
  });

  test("removes all positions for a closed patent", () => {
    const store = new PatentBookViewportStore();
    store.write("patent-1:description", 800);
    store.write("patent-1:claims", 120);
    store.write("patent-2:description", 50);

    store.removePatent("patent-1");

    expect(store.read("patent-1:description")).toBe(0);
    expect(store.read("patent-1:claims")).toBe(0);
    expect(store.read("patent-2:description")).toBe(50);
  });
});

test("restores the same document coordinate when a book moves to a differently scaled pane", async () => {
  const store = new PatentBookViewportStore();
  const view = render(
    <PatentBookViewportProvider store={store}>
      <ViewportHarness patentId="patent-1" bookKind="description" />
    </PatentBookViewportProvider>,
  );
  const node = screen.getByTestId("viewport");
  node.innerHTML =
    '<div class="patent-page-with-rail" style="--patent-page-zoom:1"><div class="patent-page-zoom-frame"></div></div>';
  setScrollGeometry(node, 5000, 600);
  await flushRestoreFrame();
  node.scrollTop = 1000;
  fireEvent.scroll(node);
  view.unmount();
  render(
    <PatentBookViewportProvider store={store}>
      <ViewportHarness patentId="patent-1" bookKind="description" />
    </PatentBookViewportProvider>,
  );
  const next = screen.getByTestId("viewport");
  next.innerHTML =
    '<div class="patent-page-with-rail" style="--patent-page-zoom:0.87"><div class="patent-page-zoom-frame"></div></div>';
  setScrollGeometry(next, 4350, 600);
  await flushRestoreFrame();
  expect(next.scrollTop).toBeCloseTo(870);
});

import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { OpenedPatent } from "../../../../shared/ipc/contract";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import type { PatentBookKind } from "../../../../shared/patent/model";
import { createPatentSession, type PatentSession } from "../patent-reducer";
import type { PatentBookPlacement } from "./persistent-book-workspace";
import { PersistentBookWorkspace } from "./persistent-book-workspace";

function session(activeBookKind: PatentBookKind): PatentSession {
  const patent = createBlankPatent({ patentType: "utility-model", name: "历史测试" });
  patent.activeBookKind = activeBookKind;
  const opened: OpenedPatent = {
    patentId: patent.patentId,
    sessionId: "00000000-0000-4000-8000-000000009901",
    revision: 0,
    patent,
    saveState: "saved",
  };
  return createPatentSession(opened);
}

describe("persistent patent book workspace", () => {
  test("replays the ruler entry motion when switching text books", async () => {
    const originalAnimate = HTMLElement.prototype.animate;
    const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
    HTMLElement.prototype.animate = animate;
    const renderBook = (current: PatentSession) => (
      <div>
        {current.activeBookKind}
        <aside className="document-structure-ruler" />
      </div>
    );

    try {
      const { rerender } = render(
        <PersistentBookWorkspace session={session("claims")} active renderBook={renderBook} />,
      );
      expect(animate).not.toHaveBeenCalled();

      rerender(
        <PersistentBookWorkspace session={session("description")} active renderBook={renderBook} />,
      );

      expect(animate).toHaveBeenCalledWith(
        [
          {
            transform: "translateX(calc(100% + var(--document-structure-ruler-gap)))",
          },
          { transform: "translateX(0)" },
        ],
        { duration: 400, easing: "ease-in-out" },
      );
      const claimsSurface = document.querySelector<HTMLElement>('[data-book-kind="claims"]');
      const descriptionSurface = document.querySelector<HTMLElement>(
        '[data-book-kind="description"]',
      );
      expect(claimsSurface?.hasAttribute("hidden")).toBe(false);
      expect(claimsSurface?.getAttribute("data-active")).toBe("false");
      expect(claimsSurface?.hasAttribute("inert")).toBe(true);
      expect(descriptionSurface?.classList).toContain("patent-book-transition-surface");
      expect(descriptionSurface?.getAttribute("data-active")).toBe("true");
      expect(descriptionSurface?.hasAttribute("inert")).toBe(false);
      expect(
        descriptionSurface
          ?.querySelector(".document-structure-ruler")
          ?.getAttribute("data-entry-motion"),
      ).toBe("true");
    } finally {
      HTMLElement.prototype.animate = originalAnimate;
    }
  });

  test("keeps every visited text book mounted while switching between them", () => {
    const mounts = new Map<PatentBookKind, number>();
    const unmounts = new Map<PatentBookKind, number>();
    function BookProbe({ kind }: { kind: PatentBookKind }) {
      useEffect(() => {
        mounts.set(kind, (mounts.get(kind) ?? 0) + 1);
        return () => {
          unmounts.set(kind, (unmounts.get(kind) ?? 0) + 1);
        };
      }, [kind]);
      return <div data-testid={`book-${kind}`}>{kind}</div>;
    }
    const renderBook = (current: PatentSession) => <BookProbe kind={current.activeBookKind} />;

    const { rerender } = render(
      <PersistentBookWorkspace session={session("claims")} active renderBook={renderBook} />,
    );
    rerender(
      <PersistentBookWorkspace session={session("description")} active renderBook={renderBook} />,
    );
    rerender(
      <PersistentBookWorkspace session={session("abstract")} active renderBook={renderBook} />,
    );
    rerender(
      <PersistentBookWorkspace session={session("claims")} active renderBook={renderBook} />,
    );

    expect(screen.getByTestId("book-claims")).toBeDefined();
    expect(screen.getByTestId("book-description")).toBeDefined();
    expect(screen.getByTestId("book-abstract")).toBeDefined();
    expect(mounts.get("claims")).toBe(1);
    expect(mounts.get("description")).toBe(1);
    expect(mounts.get("abstract")).toBe(1);
    expect(unmounts.get("claims") ?? 0).toBe(0);
    expect(unmounts.get("description") ?? 0).toBe(0);
    expect(unmounts.get("abstract") ?? 0).toBe(0);
  });

  test("does not retain either drawing page after it becomes inactive", () => {
    const renderBook = (current: PatentSession) => (
      <div data-testid={`book-${current.activeBookKind}`}>{current.activeBookKind}</div>
    );
    const { rerender } = render(
      <PersistentBookWorkspace
        session={session("description-drawings")}
        active
        renderBook={renderBook}
      />,
    );
    expect(screen.getByTestId("book-description-drawings")).toBeDefined();

    rerender(
      <PersistentBookWorkspace
        session={session("abstract-drawing")}
        active
        renderBook={renderBook}
      />,
    );

    expect(screen.queryByTestId("book-description-drawings")).toBeNull();
    expect(screen.getByTestId("book-abstract-drawing")).toBeDefined();
  });

  test("keeps an inactive patent workspace mounted but hidden", () => {
    const renderBook = (current: PatentSession) => (
      <div data-testid={`book-${current.activeBookKind}`}>
        {current.activeBookKind}
        <aside className="document-structure-ruler" />
      </div>
    );
    const originalAnimate = HTMLElement.prototype.animate;
    const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
    HTMLElement.prototype.animate = animate;
    try {
      const { container, rerender } = render(
        <PersistentBookWorkspace session={session("claims")} active renderBook={renderBook} />,
      );
      rerender(
        <PersistentBookWorkspace
          session={session("claims")}
          active={false}
          renderBook={renderBook}
        />,
      );

      expect(container.querySelector("[data-patent-workspace]")?.hasAttribute("hidden")).toBe(true);
      expect(screen.getByTestId("book-claims")).toBeDefined();

      rerender(
        <PersistentBookWorkspace session={session("claims")} active renderBook={renderBook} />,
      );
      expect(animate).toHaveBeenCalledWith(
        [
          {
            transform: "translateX(calc(100% + var(--document-structure-ruler-gap)))",
          },
          { transform: "translateX(0)" },
        ],
        { duration: 400, easing: "ease-in-out" },
      );
    } finally {
      HTMLElement.prototype.animate = originalAnimate;
    }
  });
});

describe("persistent patent book placements", () => {
  function placement(
    current: PatentSession,
    bookKind: PatentBookKind,
    pane: "left" | "right",
    active = false,
  ): PatentBookPlacement {
    return {
      pane,
      target: { patentId: current.patentId, bookKind },
      active,
    };
  }

  test("replays the ruler entry motion when a dual pane switches documents", () => {
    const originalAnimate = HTMLElement.prototype.animate;
    const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
    HTMLElement.prototype.animate = animate;
    const current = session("claims");
    const renderBook = (bookSession: PatentSession) => (
      <div>
        {bookSession.activeBookKind}
        <aside className="document-structure-ruler" />
      </div>
    );

    try {
      const view = render(
        <PersistentBookWorkspace
          sessions={[current]}
          placements={[placement(current, "claims", "left", true)]}
          renderBook={renderBook}
        />,
      );
      expect(animate).not.toHaveBeenCalled();

      view.rerender(
        <PersistentBookWorkspace
          sessions={[current]}
          placements={[placement(current, "description", "left", true)]}
          renderBook={renderBook}
        />,
      );

      expect(animate).toHaveBeenCalledWith(
        [
          {
            transform: "translateX(calc(100% + var(--document-structure-ruler-gap)))",
          },
          { transform: "translateX(0)" },
        ],
        { duration: 400, easing: "ease-in-out" },
      );
    } finally {
      HTMLElement.prototype.animate = originalAnimate;
    }
  });

  test("shows two books from the same patent and from different patents", () => {
    const first = session("claims");
    const second = session("description");
    second.patentId = "00000000-0000-4000-8000-000000009902";
    second.patent.patentId = second.patentId;
    const renderBook = (current: PatentSession, currentPlacement: PatentBookPlacement | null) => (
      <div data-testid={`${current.patentId}-${current.activeBookKind}`}>
        {currentPlacement?.pane ?? "hidden"}
      </div>
    );

    const { rerender } = render(
      <PersistentBookWorkspace
        sessions={[first]}
        placements={[
          placement(first, "claims", "left", true),
          placement(first, "description", "right"),
        ]}
        renderBook={renderBook}
      />,
    );
    expect(screen.getByTestId(`${first.patentId}-claims`).textContent).toBe("left");
    expect(screen.getByTestId(`${first.patentId}-description`).textContent).toBe("right");

    rerender(
      <PersistentBookWorkspace
        sessions={[first, second]}
        placements={[
          placement(first, "claims", "left", true),
          placement(second, "description", "right"),
        ]}
        renderBook={renderBook}
      />,
    );
    expect(screen.getByTestId(`${second.patentId}-description`).textContent).toBe("right");
  });

  test("deduplicates a repeated target and preserves its mounted editor when panes swap", () => {
    const current = session("claims");
    const mounts = new Map<PatentBookKind, number>();
    const unmounts = new Map<PatentBookKind, number>();
    function Probe({ kind }: { kind: PatentBookKind }) {
      useEffect(() => {
        mounts.set(kind, (mounts.get(kind) ?? 0) + 1);
        return () => {
          unmounts.set(kind, (unmounts.get(kind) ?? 0) + 1);
        };
      }, [kind]);
      return <div data-testid={`placement-${kind}`} />;
    }
    const renderBook = (bookSession: PatentSession) => <Probe kind={bookSession.activeBookKind} />;

    const { rerender } = render(
      <PersistentBookWorkspace
        sessions={[current]}
        placements={[
          placement(current, "claims", "left", true),
          placement(current, "claims", "right"),
          placement(current, "description", "right"),
        ]}
        renderBook={renderBook}
      />,
    );
    expect(screen.getAllByTestId("placement-claims")).toHaveLength(1);

    rerender(
      <PersistentBookWorkspace
        sessions={[current]}
        placements={[
          placement(current, "description", "left"),
          placement(current, "claims", "right", true),
        ]}
        renderBook={renderBook}
      />,
    );
    expect(mounts.get("claims")).toBe(1);
    expect(mounts.get("description")).toBe(1);
    expect(unmounts.get("claims") ?? 0).toBe(0);
    expect(unmounts.get("description") ?? 0).toBe(0);
    expect(
      screen
        .getByTestId("placement-claims")
        .closest("[data-workspace-pane]")
        ?.getAttribute("data-workspace-pane"),
    ).toBe("right");
  });

  test("keeps visited text books mounted but removes a hidden or deleted drawing book", () => {
    const current = session("claims");
    const renderBook = (bookSession: PatentSession) => (
      <div data-testid={`placed-${bookSession.activeBookKind}`} />
    );
    const { rerender } = render(
      <PersistentBookWorkspace
        sessions={[current]}
        placements={[
          placement(current, "claims", "left"),
          placement(current, "description-drawings", "right"),
        ]}
        renderBook={renderBook}
      />,
    );

    rerender(
      <PersistentBookWorkspace
        sessions={[current]}
        placements={[placement(current, "description", "left")]}
        renderBook={renderBook}
      />,
    );
    expect(screen.getByTestId("placed-claims")).toBeDefined();
    expect(
      screen.getByTestId("placed-claims").closest("[data-book-target]")?.hasAttribute("hidden"),
    ).toBe(true);
    expect(screen.queryByTestId("placed-description-drawings")).toBeNull();

    current.patent.drawingBooksEnabled = false;
    rerender(
      <PersistentBookWorkspace
        sessions={[current]}
        placements={[placement(current, "description-drawings", "right")]}
        renderBook={renderBook}
      />,
    );
    expect(screen.queryByTestId("placed-description-drawings")).toBeNull();
  });
});

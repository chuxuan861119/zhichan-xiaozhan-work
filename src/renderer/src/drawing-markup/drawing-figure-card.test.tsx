import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DrawingFigureCard } from "./drawing-figure-card";

vi.mock("../patents/editors/asset-preview", () => ({
  AssetPreview: ({ alt, onLoad }: { alt: string; onLoad: (ratio: number) => void }) => (
    <img src="preview.png" alt={alt} onLoad={() => onLoad(2)} />
  ),
}));
const props = {
  sessionId: "session",
  assetId: "asset",
  figureId: "figure",
  name: "图1",
  selected: false,
  disabled: false,
  onLocate: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

test("uses image proportions, spans wide images and keeps keyboard and click location", () => {
  render(<DrawingFigureCard {...props} aspectRatio={0.4} />);
  const card = screen.getByRole("button", { name: "定位图1" });
  expect(card.getAttribute("data-wide")).toBe("false");
  fireEvent.load(screen.getByRole("img"));
  expect(card.getAttribute("data-wide")).toBe("true");
  fireEvent.click(card);
  fireEvent.keyDown(card, { key: "Enter" });
  fireEvent.keyDown(card, { key: " " });
  expect(props.onLocate).toHaveBeenCalledTimes(3);
});

test("opens a delayed complete preview and dismisses it on Escape, scroll or leaving", () => {
  vi.useFakeTimers();
  render(<DrawingFigureCard {...props} />);
  const card = screen.getByRole("button", { name: "定位图1" });
  fireEvent.mouseEnter(card);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseLeave(card);
  act(() => vi.advanceTimersByTime(400));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseEnter(card);
  act(() => vi.advanceTimersByTime(400));
  expect(screen.getByRole("tooltip").querySelector("img")?.getAttribute("src")).toContain(
    "preview.png",
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseLeave(card);
  fireEvent.mouseEnter(card);
  act(() => vi.advanceTimersByTime(400));
  fireEvent.scroll(document);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(props.onLocate).not.toHaveBeenCalled();
});

test("disabling or unmounting a card cancels its preview and blocks location", () => {
  vi.useFakeTimers();
  const view = render(<DrawingFigureCard {...props} />);
  const card = screen.getByRole("button", { name: "定位图1" });
  fireEvent.mouseEnter(card);
  act(() => vi.advanceTimersByTime(400));
  view.rerender(<DrawingFigureCard {...props} disabled />);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(card);
  expect(props.onLocate).not.toHaveBeenCalled();
  view.rerender(<DrawingFigureCard {...props} />);
  fireEvent.mouseEnter(card);
  view.unmount();
  act(() => vi.advanceTimersByTime(400));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

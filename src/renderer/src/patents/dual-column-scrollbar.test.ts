import { createColumnScrollbar } from "./dual-column-scrollbar";

test("native scrollbar mirrors positions without feeding programmatic updates back into wheel motion", () => {
  const parent = document.createElement("div");
  const moved = vi.fn();
  const scrollbar = createColumnScrollbar(parent, moved);
  const element = parent.firstElementChild as HTMLElement;
  expect(element.tagName).toBe("DIV");
  scrollbar.measure({ top: 90, right: 1600, height: 800, gutter: 15 });
  expect(element.style.left).toBe("1584px");
  expect(element.style.height).toBe("800px");
  scrollbar.update(1200, 125.5);
  expect((element.firstElementChild as HTMLElement).style.height).toBe("2000px");
  element.dispatchEvent(new Event("scroll"));
  expect(moved).not.toHaveBeenCalled();
  element.scrollTop = 600;
  element.dispatchEvent(new Event("scroll"));
  expect(moved).toHaveBeenCalledWith(600);
  scrollbar.update(0, 0);
  expect(element.getAttribute("aria-valuemax")).toBe("0");
  scrollbar.destroy();
  element.scrollTop = 700;
  element.dispatchEvent(new Event("scroll"));
  expect(moved).toHaveBeenCalledTimes(1);
  expect(parent.childElementCount).toBe(0);
});

test("fractional synchronization does not turn queued scroll feedback into another document scroll", () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const onScroll = vi.fn();
  const controller = createColumnScrollbar(parent, onScroll);
  const element = parent.querySelector<HTMLElement>(".dual-column-scrollbar")!;
  let top = 0;
  let reads = 0;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => {
      reads++;
      return top;
    },
    set: (next: number) => {
      top = Math.round(next);
    },
  });
  controller.measure({ top: 0, right: 1000, height: 800, gutter: 16 });
  controller.update(2000, 10.4);
  expect(reads).toBe(0);
  element.dispatchEvent(new Event("scroll"));
  expect(onScroll).not.toHaveBeenCalled();
  element.scrollTop = 120;
  element.dispatchEvent(new Event("scroll"));
  expect(onScroll).toHaveBeenCalledWith(120);
  controller.destroy();
});

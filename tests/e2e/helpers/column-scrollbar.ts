import type { Page } from "@playwright/test";

export function columnScrollbar(page: Page) {
  const locator = page.getByRole("scrollbar", { name: "双列文档滚动位置" });
  return {
    async fill(value: string) {
      await locator.evaluate((element, value) => {
        element.scrollTop = Number(value);
        element.dispatchEvent(new Event("scroll"));
      }, value);
    },
    inputValue: () => locator.evaluate((element) => String(element.scrollTop)),
    getAttribute: (name: string) => locator.getAttribute(name === "max" ? "aria-valuemax" : name),
  };
}

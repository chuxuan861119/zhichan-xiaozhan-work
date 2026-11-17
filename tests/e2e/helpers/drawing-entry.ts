import type { Page } from "@playwright/test";

/** Toolbar actions may live either in the visible strip or its overflow menu. */
export async function openDrawingEntry(page: Page, label: "插入流程图" | "电路图") {
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  const button = page.getByRole("button", { name: label, exact: true });
  const available = button
    .or(page.getByRole("button", { name: "更多工具", exact: true }))
    .filter({ visible: true })
    .first();
  await available.waitFor({ state: "visible" });
  const overflow = (await available.getAttribute("aria-label")) === "更多工具";
  await available.click();
  if (overflow) await page.getByText(label, { exact: true }).click();
}

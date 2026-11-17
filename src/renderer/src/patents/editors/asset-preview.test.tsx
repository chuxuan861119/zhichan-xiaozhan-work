import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssetPreview } from "./asset-preview";

test("retries a failed drawing preview locally", async () => {
  const getPreview = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: { code: "NOT_FOUND", message: "missing" } })
    .mockResolvedValueOnce({ ok: true, value: Uint8Array.from([1, 2, 3]) });
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { assets: { getPreview } },
  });

  render(<AssetPreview sessionId="session" assetId="asset" alt="图1" />);
  const retry = await screen.findByRole("button", { name: "重试加载图1" });
  fireEvent.click(retry);

  await waitFor(() => expect(screen.getByRole("img", { name: "图1" })).toBeDefined());
  expect(getPreview).toHaveBeenCalledTimes(2);
});

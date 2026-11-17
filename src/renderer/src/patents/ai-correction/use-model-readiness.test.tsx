import { renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useModelReadiness } from "./use-model-readiness";

test("requires both credentials and permission and refreshes after configuration", async () => {
  const getSettings = vi.fn(async () => ({
    ok: true,
    value: { credentialProfileIds: [] as string[] },
  }));
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { aiCorrection: { getSettings } },
  });
  const { result, rerender } = renderHook(
    ({ enabled, refresh }) => useModelReadiness("model", false, enabled, refresh),
    { initialProps: { enabled: true, refresh: false } },
  );
  await waitFor(() => expect(getSettings).toHaveBeenCalledOnce());
  expect(result.current).toBe(false);
  getSettings.mockResolvedValue({ ok: true, value: { credentialProfileIds: ["model"] } });
  rerender({ enabled: true, refresh: true });
  await waitFor(() => expect(result.current).toBe(true));
  rerender({ enabled: false, refresh: true });
  expect(result.current).toBe(false);
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContentSearchSettings } from "./content-search-settings";

const confirm = vi.hoisted(() => vi.fn());
vi.mock("../shared/app-dialog", () => ({ confirmAppAction: confirm }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("allows an idle-waiting automatic task to be continued immediately", async () => {
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      enabled: true,
      running: true,
      manual: false,
      paused: true,
      completed: 1,
      total: 5,
      updatedAt: null,
      error: false,
      incomplete: true,
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  confirm.mockResolvedValue(true);
  render(<ContentSearchSettings />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "立即索引" })).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("button", { name: "立即索引" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ action: "start" }));
});
it("requires confirmation before manual indexing and supports cancelling without changing the switch", async () => {
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      enabled: false,
      running: false,
      completed: 0,
      total: 0,
      updatedAt: null,
      error: false,
      incomplete: true,
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchSettings />);
  const start = screen.getByRole("button", { name: "立即索引" });
  await waitFor(() => expect(start).toHaveProperty("disabled", false));
  confirm.mockResolvedValueOnce(false);
  fireEvent.click(start);
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(request).not.toHaveBeenCalledWith({ action: "start" });
  confirm.mockResolvedValueOnce(true);
  fireEvent.click(start);
  await waitFor(() => expect(request).toHaveBeenCalledWith({ action: "start" }));
  expect(request).not.toHaveBeenCalledWith({ action: "configure", enabled: true });
});

import { requestApplicationExit } from "./application-exit.js";

test("Harmony exits through the main process rather than the renderer window", async () => {
  const close = vi.fn();
  const requestQuit = vi.fn(async () => ({ ok: true as const, value: undefined }));
  await expect(requestApplicationExit({ requestQuit }, close, "openharmony")).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(requestQuit).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});
test("Harmony never falls back to an unprotected window close", async () => {
  const close = vi.fn();
  await expect(requestApplicationExit({}, close, "openharmony")).rejects.toThrow();
  expect(close).not.toHaveBeenCalled();
});
test("other platforms retain their existing window close behavior", async () => {
  const close = vi.fn();
  const requestQuit = vi.fn();
  await requestApplicationExit({ requestQuit }, close, "darwin");
  expect(close).toHaveBeenCalledOnce();
  expect(requestQuit).not.toHaveBeenCalled();
});

test("quit request failure remains visible to the caller and keeps the window alive", async () => {
  const close = vi.fn();
  const failure = {
    ok: false as const,
    error: { code: "INVALID_INPUT" as const, message: "Request rejected" },
  };
  await expect(
    requestApplicationExit({ requestQuit: vi.fn(async () => failure) }, close, "openharmony"),
  ).resolves.toEqual(failure);
  expect(close).not.toHaveBeenCalled();
});

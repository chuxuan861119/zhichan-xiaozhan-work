import { IpcFrameMessageSchema, isIpcDataPageUrl } from "./ipc-data-center.js";

test("accepts only the fixed page and bounded message operations", () => {
  expect(isIpcDataPageUrl("patent-ipc://center/index.html")).toBe(true);
  for (const url of [
    "patent-ipc://center/other.html",
    "patent-ipc://center/index.html?remote=1",
    "patent-ipc://evil/index.html",
    "https://center/index.html",
    "patent-ipc://user@center/index.html",
  ])
    expect(isIpcDataPageUrl(url)).toBe(false);
  expect(
    IpcFrameMessageSchema.safeParse({
      source: "ipc-data-center",
      action: "copy",
      id: 1,
      text: "A01B",
    }).success,
  ).toBe(true);
  for (const input of [
    { source: "ipc-data-center", action: "delete" },
    { source: "ipc-data-center", action: "copy", id: 1, text: "A01B", path: "C:/private" },
    { source: "ipc-data-center", action: "copy", id: 1, text: "a".repeat(1_000_001) },
  ])
    expect(IpcFrameMessageSchema.safeParse(input).success).toBe(false);
});

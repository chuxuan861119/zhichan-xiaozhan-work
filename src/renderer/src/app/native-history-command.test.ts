import { dispatchNativeHistoryCommand } from "./native-history-command";

beforeEach(() => {
  vi.stubGlobal("documentFontPlatform", "darwin");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("Harmony native menu editing dispatches Control rather than the system Harmony key", () => {
  vi.stubGlobal("documentFontPlatform", "openharmony");
  const target = document.createElement("button");
  document.body.append(target);
  target.focus();
  const handled = vi.fn((event: KeyboardEvent) => event.preventDefault());
  target.addEventListener("keydown", handled);
  dispatchNativeHistoryCommand("undo", vi.fn());
  expect(handled.mock.calls[0]?.[0]).toMatchObject({ key: "z", ctrlKey: true, metaKey: false });
});

test("routes native undo and redo through the focused editor's existing keyboard handler", () => {
  const target = document.createElement("button");
  document.body.append(target);
  target.focus();
  const handled = vi.fn((event: KeyboardEvent) => event.preventDefault());
  target.addEventListener("keydown", handled);
  const fallback = vi.fn();
  dispatchNativeHistoryCommand("undo", fallback);
  dispatchNativeHistoryCommand("redo", fallback);
  expect(handled).toHaveBeenCalledTimes(2);
  expect(handled.mock.calls[0]?.[0]).toMatchObject({ key: "z", metaKey: true, shiftKey: false });
  expect(handled.mock.calls[1]?.[0]).toMatchObject({ key: "z", metaKey: true, shiftKey: true });
  expect(fallback).not.toHaveBeenCalled();
});

test("ordinary text controls retain native history without changing document history", () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  const fallback = vi.fn();
  dispatchNativeHistoryCommand("undo", fallback);
  expect(fallback).toHaveBeenCalledWith("undo");
});

test("native editing menus reach custom canvas handlers before native fallback", async () => {
  const { dispatchNativeEditCommand } = await import("./native-history-command");
  const canvas = document.createElement("button");
  document.body.append(canvas);
  canvas.focus();
  const keys: string[] = [];
  canvas.addEventListener("keydown", (event) => {
    keys.push(event.key);
    event.preventDefault();
  });
  const fallback = vi.fn();
  for (const command of ["select-all", "copy", "paste", "cut"] as const)
    dispatchNativeEditCommand(command, fallback);
  expect(keys).toEqual(["a", "c", "v", "x"]);
  expect(fallback).not.toHaveBeenCalled();
});

test("ordinary text editing falls back without changing its selection", async () => {
  const { dispatchNativeEditCommand } = await import("./native-history-command");
  const input = document.createElement("input");
  input.value = "正文";
  document.body.append(input);
  input.focus();
  input.setSelectionRange(0, 1);
  const fallback = vi.fn();
  dispatchNativeEditCommand("copy", fallback);
  expect(fallback).toHaveBeenCalledWith("copy");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(1);
});

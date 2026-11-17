import { act, renderHook } from "@testing-library/react";
import { usePointerFrame } from "./use-pointer-frame";

test("previews only the latest pointer sample and release flushes synchronously without a late frame", () => {
  let callback: FrameRequestCallback | undefined;
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
    callback = next;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const apply = vi.fn();
  const { result, unmount } = renderHook(() => usePointerFrame(apply));
  act(() => {
    result.current.schedule(1);
    result.current.schedule(2);
  });
  expect(apply).not.toHaveBeenCalled();
  act(() => callback?.(0));
  expect(apply.mock.calls).toEqual([[2]]);
  act(() => {
    result.current.schedule(3);
    result.current.flush(4);
  });
  expect(apply.mock.calls).toEqual([[2], [4]]);
  act(() => callback?.(0));
  expect(apply.mock.calls).toEqual([[2], [4]]);
  act(() => {
    result.current.schedule(5);
    result.current.cancel();
  });
  act(() => callback?.(0));
  expect(apply).toHaveBeenCalledTimes(2);
  unmount();
  vi.unstubAllGlobals();
});

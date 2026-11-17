import { act, renderHook, waitFor } from "@testing-library/react";
import { editorBelongsToSession } from "./editor-session-scope";
import { useSessionState } from "./use-session-state";
import { useExclusiveEditorRuntime } from "./use-exclusive-editor-runtime";

test("session drafts survive switches and late setters cannot write into another or reopened session", () => {
  const { result, rerender } = renderHook(({ owner, ids }) => useSessionState(owner, "", ids), {
    initialProps: { owner: "a", ids: ["a", "b"] },
  });
  const setA = result.current[1];
  act(() => setA("draft A"));
  rerender({ owner: "b", ids: ["a", "b"] });
  expect(result.current[0]).toBe("");
  act(() => result.current[1]("draft B"));
  act(() => setA("late A"));
  expect(result.current[0]).toBe("draft B");
  rerender({ owner: "a", ids: ["a", "b"] });
  expect(result.current[0]).toBe("late A");
  rerender({ owner: "a-new", ids: ["a-new", "b"] });
  act(() => setA("must not return"));
  expect(result.current[0]).toBe("");
  expect(result.current[2].a).toBeUndefined();
});

test("runtime handoff waits for saving, retains the old owner on failure, and retries", async () => {
  let finish!: (value: boolean) => void;
  const flush = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ desired }) => useExclusiveEditorRuntime(desired, ["a", "b"], flush),
    { initialProps: { desired: "a" } },
  );
  await waitFor(() => expect(result.current.owner).toBe("a"));
  rerender({ desired: "b" });
  expect(result.current.owner).toBe("a");
  await act(async () => finish(false));
  expect(result.current.failed).toBe(true);
  expect(result.current.owner).toBe("a");
  act(() => result.current.retry());
  await act(async () => finish(true));
  expect(result.current.owner).toBe("b");
});

test("rapid return invalidates an in-flight runtime handoff", async () => {
  let finish!: (value: boolean) => void;
  const flush = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ desired }) => useExclusiveEditorRuntime(desired, ["a", "b"], flush),
    { initialProps: { desired: "a" } },
  );
  await waitFor(() => expect(result.current.owner).toBe("a"));
  rerender({ desired: "b" });
  rerender({ desired: "a" });
  await act(async () => finish(true));
  expect(result.current.owner).toBe("a");
  expect(result.current.pending).toBe(false);
});

test("focused insertion accepts only the exact session or one of its books", () => {
  expect(editorBelongsToSession("a:description", "a")).toBe(true);
  expect(editorBelongsToSession("a", "a")).toBe(true);
  expect(editorBelongsToSession("ab:description", "a")).toBe(false);
  expect(editorBelongsToSession("b:description", "a")).toBe(false);
});

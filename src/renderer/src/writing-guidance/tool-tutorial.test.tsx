import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { AppResult } from "../../../shared/ipc/result";
import type { TutorialContext } from "../../../shared/tutorial/model";
import { ToolTutorial, TUTORIAL_OPEN_EVENT } from "./tool-tutorial";

const completed = vi.hoisted(() => ({ value: false }));
vi.mock("../../../shared/tutorial/model", async (original) => ({
  ...(await original<object>()),
  tutorialCompleted: () => completed.value,
}));
const requestQuit = vi.fn(async (): Promise<AppResult<void>> => ({ ok: true, value: undefined }));
const context: TutorialContext = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  patentId: "00000000-0000-4000-8000-000000000002",
  lessonId: "figure-sort",
  baseline: { paragraphId: "00000000-0000-4000-8000-000000000003", figureOrder: [] },
};
beforeEach(() => {
  vi.clearAllMocks();
  completed.value = false;
  window.patentApi = {
    tutorial: {
      isSession: true,
      read: async () => ({ ok: true, value: context }),
      ready: async () => ({ ok: true, value: undefined }),
    },
    application: { requestQuit },
  } as unknown as PatentApi;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function showTutorial() {
  await act(async () => {
    render(
      <ToolTutorial
        patent={null}
        onOpen={async () => {}}
        onClose={async () => true}
        onNavigate={async () => {}}
      />,
    );
  });
}
test("closing the tutorial coach also exits when collapsed", async () => {
  await showTutorial();
  fireEvent.click(screen.getByRole("button", { name: "折叠练习引导" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭教程" }));
  expect(requestQuit).toHaveBeenCalledOnce();
});
test("closing the directory in a tutorial session exits the teaching process", async () => {
  await showTutorial();
  fireEvent.click(screen.getByRole("button", { name: "课程目录" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "快速工具教程" })).getByRole("button", {
      name: "关闭快速工具教程",
    }),
  );
  expect(requestQuit).toHaveBeenCalledOnce();
});
test("finishing the last lesson exits instead of reopening the directory", async () => {
  completed.value = true;
  await showTutorial();
  fireEvent.click(
    within(document.querySelector(".tool-tutorial-coach-actions") as HTMLElement).getByRole(
      "button",
      { name: "完成教学" },
    ),
  );
  expect(requestQuit).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "快速工具教程" })).toBeNull();
});

test("returning from the directory keeps the exercise open", async () => {
  await showTutorial();
  fireEvent.click(screen.getByRole("button", { name: "课程目录" }));
  fireEvent.click(screen.getByRole("button", { name: "返回练习" }));
  expect(requestQuit).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "快速工具教程" })).toBeNull();
});

test("cancelling the course chooser in the normal application does not quit it", async () => {
  window.patentApi = {
    ...window.patentApi,
    tutorial: { ...window.patentApi.tutorial, isSession: false },
  } as PatentApi;
  await showTutorial();
  act(() => window.dispatchEvent(new Event(TUTORIAL_OPEN_EVENT)));
  fireEvent.click(screen.getByRole("button", { name: "关闭快速工具教程" }));
  expect(requestQuit).not.toHaveBeenCalled();
});

test("a failed exit remains visible and can be retried", async () => {
  requestQuit.mockResolvedValueOnce({
    ok: false,
    error: { code: "INTERNAL", message: "退出未完成，请重试。" },
  });
  await showTutorial();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "关闭教程" })));
  expect(screen.getByRole("alert").textContent).toContain("退出未完成，请重试。");
  fireEvent.click(screen.getByRole("button", { name: "关闭教程" }));
  expect(requestQuit).toHaveBeenCalledTimes(2);
});

test("the coach can be closed while lesson preparation is still pending", () => {
  render(
    <ToolTutorial
      patent={null}
      onOpen={() => new Promise<void>(() => {})}
      onClose={async () => true}
      onNavigate={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭教程" }));
  expect(requestQuit).toHaveBeenCalledOnce();
});

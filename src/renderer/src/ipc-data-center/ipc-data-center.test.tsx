import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IPC_DATA_ORIGIN } from "../../../shared/ipc-data-center";
import { useDialogDrag } from "../shared/use-dialog-drag";
import { IpcDataCenter } from "./ipc-data-center";

test("maximizes inside the host and restores without recreating the query page", () => {
  render(<IpcDataCenter />);
  fireEvent.click(screen.getByRole("button", { name: "IPC数据中心" }));
  const frame = screen.getByTitle("IPC数据中心查询页面");
  const dialog = screen.getByRole("dialog", { name: "IPC数据中心" });
  fireEvent.click(screen.getByRole("button", { name: "最大化IPC数据中心" }));
  expect(dialog.style.width).toBe("100%");
  expect(dialog.style.top).toBe("38px");
  expect(dialog.style.height).toBe("calc(100% - 38px)");
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "IPC数据中心" })).toBe(dialog);
  expect(dialog.style.width).not.toBe("100%");
  fireEvent.click(screen.getByRole("button", { name: "最大化IPC数据中心" }));
  fireEvent.click(screen.getByRole("button", { name: "还原IPC数据中心" }));
  expect(dialog.style.width).not.toBe("100%");
  expect(screen.getByTitle("IPC数据中心查询页面")).toBe(frame);
});

test("opens without stealing editor focus and preserves the frame when hidden", () => {
  render(
    <>
      <textarea aria-label="正文" />
      <IpcDataCenter />
    </>,
  );
  const editor = screen.getByRole("textbox", { name: "正文" });
  editor.focus();
  fireEvent.mouseDown(screen.getByRole("button", { name: "IPC数据中心" }));
  fireEvent.click(screen.getByRole("button", { name: "IPC数据中心" }));
  expect(document.activeElement).toBe(editor);
  const dialog = screen.getByRole("dialog", { name: "IPC数据中心" });
  expect(dialog.getAttribute("aria-modal")).not.toBe("true");
  const frame = screen.getByTitle("IPC数据中心查询页面");
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "IPC数据中心" })).toBe(dialog);
  fireEvent.click(screen.getByRole("button", { name: "返回编辑器" }));
  expect(screen.queryByRole("dialog", { name: "IPC数据中心" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "IPC数据中心" }));
  expect(screen.getByTitle("IPC数据中心查询页面")).toBe(frame);
});

test("only the embedded origin and frame can request native clipboard writes", async () => {
  const writeText = vi.fn().mockResolvedValue({ ok: false, error: { message: "剪贴板暂不可用" } });
  vi.stubGlobal("patentApi", { clipboard: { writeText } });
  try {
    render(<IpcDataCenter />);
    fireEvent.click(screen.getByRole("button", { name: "IPC数据中心" }));
    const frame = screen.getByTitle<HTMLIFrameElement>("IPC数据中心查询页面");
    const sender = frame.contentWindow;
    if (!sender) throw new Error("Missing frame window");
    const reply = vi.spyOn(sender, "postMessage");
    const data = { source: "ipc-data-center", action: "copy", id: 1, text: "A01B1/02" };
    fireEvent(
      window,
      new MessageEvent("message", { data, origin: "https://untrusted.test", source: sender }),
    );
    fireEvent(
      window,
      new MessageEvent("message", { data, origin: IPC_DATA_ORIGIN, source: window }),
    );
    expect(writeText).not.toHaveBeenCalled();
    fireEvent(
      window,
      new MessageEvent("message", { data, origin: IPC_DATA_ORIGIN, source: sender }),
    );
    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith(
        { source: "ipc-data-host", id: 1, ok: false, error: "剪贴板暂不可用" },
        IPC_DATA_ORIGIN,
      ),
    );
    expect(writeText).toHaveBeenCalledWith("A01B1/02");
    fireEvent.click(screen.getByRole("button", { name: "返回编辑器" }));
    writeText.mockClear();
    fireEvent(
      window,
      new MessageEvent("message", { data, origin: IPC_DATA_ORIGIN, source: sender }),
    );
    expect(writeText).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Escape restores a maximized tool while editor focus remains outside it", () => {
  render(
    <>
      <textarea aria-label="正文" />
      <IpcDataCenter />
    </>,
  );
  const editor = screen.getByRole("textbox", { name: "正文" });
  editor.focus();
  fireEvent.click(screen.getByRole("button", { name: "IPC数据中心" }));
  fireEvent.click(screen.getByRole("button", { name: "最大化IPC数据中心" }));
  const dialog = screen.getByRole("dialog", { name: "IPC数据中心" });
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(dialog.style.width).not.toBe("100%");
  expect(document.activeElement).toBe(editor);
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "IPC数据中心" })).toBe(dialog);
});

function OtherFloatingTool() {
  const drag = useDialogDrag<HTMLDivElement>({ positionKey: "other-test-tool", stackable: true });
  return <div ref={drag.surfaceRef} role="dialog" aria-label="其他工具" />;
}

test("a higher floating tool keeps Escape from restoring IPC underneath it", () => {
  const view = render(
    <>
      <textarea aria-label="正文" />
      <IpcDataCenter />
    </>,
  );
  const editor = screen.getByRole("textbox", { name: "正文" });
  editor.focus();
  fireEvent.click(screen.getByRole("button", { name: "IPC数据中心" }));
  fireEvent.click(screen.getByRole("button", { name: "最大化IPC数据中心" }));
  view.rerender(
    <>
      <textarea aria-label="正文" />
      <IpcDataCenter />
      <OtherFloatingTool />
    </>,
  );
  const dialog = screen.getByRole("dialog", { name: "IPC数据中心" });
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(dialog.style.width).toBe("100%");
  view.rerender(
    <>
      <textarea aria-label="正文" />
      <IpcDataCenter />
    </>,
  );
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(dialog.style.width).not.toBe("100%");
});

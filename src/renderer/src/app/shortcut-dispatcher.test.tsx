import { fireEvent, render, screen } from "@testing-library/react";
import { type PropsWithChildren, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SHORTCUT_SETTINGS,
  type ShortcutSettings,
} from "../../../shared/settings/shortcuts";
import { ShortcutProvider, useShortcutAction } from "./shortcut-dispatcher";

function Provider({ settings, children }: PropsWithChildren<{ settings?: ShortcutSettings }>) {
  return (
    <ShortcutProvider settings={settings ?? DEFAULT_SHORTCUT_SETTINGS}>{children}</ShortcutProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

test("Mac dispatches physical Control and Command to separate actions", () => {
  vi.stubGlobal("documentFontPlatform", "darwin");
  const control = vi.fn(() => true);
  const command = vi.fn(() => true);
  render(
    <Provider
      settings={{
        ...DEFAULT_SHORTCUT_SETTINGS,
        "check-problems": "Control+K",
        "ai-correction": "Ctrl+K",
      }}
    >
      <ActionHarness actionId="check-problems" onRun={control} />
      <ActionHarness actionId="ai-correction" onRun={command} />
    </Provider>,
  );
  fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
  expect(control).toHaveBeenCalledOnce();
  expect(command).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
  expect(command).toHaveBeenCalledOnce();
  expect(control).toHaveBeenCalledOnce();
});

test("Mac does not consume a legacy custom binding assigned to closing the window", () => {
  vi.stubGlobal("documentFontPlatform", "darwin");
  const onRun = vi.fn(() => true);
  render(
    <Provider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "check-problems": "Ctrl+W" }}>
      <ActionHarness actionId="check-problems" onRun={onRun} />
    </Provider>,
  );
  expect(fireEvent.keyDown(window, { key: "w", code: "KeyW", metaKey: true })).toBe(true);
  expect(onRun).not.toHaveBeenCalled();
});

function ActionHarness({
  actionId = "clear-extra-formatting",
  onRun,
}: {
  actionId?: Parameters<typeof useShortcutAction>[0];
  onRun(): boolean;
}) {
  useShortcutAction(actionId, true, onRun);
  return <div className="patent-prosemirror" contentEditable data-testid="patent-editor" />;
}

describe("shortcut dispatcher", () => {
  test("leaves a legacy save binding to the built-in save command", () => {
    const onRun = vi.fn(() => true);
    render(
      <Provider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "check-problems": "Ctrl+S" }}>
        <ActionHarness actionId="check-problems" onRun={onRun} />
      </Provider>,
    );
    expect(
      fireEvent.keyDown(screen.getByTestId("patent-editor"), {
        code: "KeyS",
        key: "s",
        ctrlKey: true,
      }),
    ).toBe(true);
    expect(onRun).not.toHaveBeenCalled();
  });
  test("ignores a mounted hidden dialog when routing editor shortcuts", () => {
    const onRun = vi.fn(() => true);
    render(
      <Provider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "clear-extra-formatting": "F8" }}>
        <div hidden>
          <div role="dialog" aria-modal="true" />
        </div>
        <ActionHarness onRun={onRun} />
      </Provider>,
    );
    fireEvent.keyDown(screen.getByTestId("patent-editor"), { code: "F8", key: "F8" });
    expect(onRun).toHaveBeenCalledOnce();
  });

  test("dispatches a configured F key inside the patent editor", () => {
    const onRun = vi.fn(() => true);
    render(
      <Provider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "clear-extra-formatting": "F8" }}>
        <ActionHarness onRun={onRun} />
      </Provider>,
    );

    const event = fireEvent.keyDown(screen.getByTestId("patent-editor"), {
      code: "F8",
      key: "F8",
    });

    expect(onRun).toHaveBeenCalledOnce();
    expect(event).toBe(false);
  });

  test("does not dispatch inside normal inputs, composition sessions or modal dialogs", () => {
    const onRun = vi.fn(() => true);
    const DialogHarness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开弹窗
          </button>
          <input aria-label="普通输入框" />
          {open ? <div aria-modal="true" role="dialog" /> : null}
          <ActionHarness onRun={onRun} />
        </>
      );
    };
    render(
      <Provider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "clear-extra-formatting": "F8" }}>
        <DialogHarness />
      </Provider>,
    );

    expect(
      fireEvent.keyDown(screen.getByRole("textbox", { name: "普通输入框" }), {
        code: "F8",
        key: "F8",
      }),
    ).toBe(true);
    expect(onRun).not.toHaveBeenCalled();

    expect(
      fireEvent.keyDown(screen.getByTestId("patent-editor"), {
        code: "F8",
        key: "F8",
        isComposing: true,
      }),
    ).toBe(true);
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "打开弹窗" }));
    expect(fireEvent.keyDown(screen.getByTestId("patent-editor"), { code: "F8", key: "F8" })).toBe(
      true,
    );
    expect(onRun).not.toHaveBeenCalled();
  });

  test("does not consume a configured shortcut without an active handler", () => {
    render(
      <Provider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "clear-extra-formatting": "F8" }}>
        <div data-testid="empty" />
      </Provider>,
    );

    expect(fireEvent.keyDown(screen.getByTestId("empty"), { code: "F8", key: "F8" })).toBe(true);
  });

  test("dispatches a custom dual-view shortcut beyond the third preset", () => {
    const onRun = vi.fn(() => true);
    render(
      <Provider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "open-custom-dual-view-4": "F9" }}>
        <ActionHarness actionId="open-custom-dual-view-4" onRun={onRun} />
      </Provider>,
    );

    expect(fireEvent.keyDown(screen.getByTestId("patent-editor"), { code: "F9", key: "F9" })).toBe(
      false,
    );
    expect(onRun).toHaveBeenCalledOnce();
  });
});

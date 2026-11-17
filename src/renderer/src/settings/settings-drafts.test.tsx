import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { SettingsDraftProvider, useSettingsClose, useSettingsDraft } from "./settings-drafts";

function Form({ save }: { save: () => Promise<boolean> }) {
  const [dirty, setDirty] = useState(false);
  const close = useSettingsClose();
  useSettingsDraft({ label: "测试设置", dirty, save, discard: () => setDirty(false) });
  return (
    <>
      <button type="button" onClick={() => setDirty(true)}>
        修改
      </button>
      <button type="button" onClick={close}>
        关闭
      </button>
    </>
  );
}

test("protects drafts and keeps the settings open if saving fails", async () => {
  const onClose = vi.fn();
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(
    <SettingsDraftProvider onClose={onClose}>
      <Form save={save} />
    </SettingsDraftProvider>,
  );
  fireEvent.click(screen.getByText("修改"));
  fireEvent.click(screen.getByText("关闭"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("保存并关闭"));
  await screen.findByRole("alert");
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("保存并关闭"));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

test("allows explicit discard but never saves when continuing editing", () => {
  const onClose = vi.fn();
  const save = vi.fn();
  render(
    <SettingsDraftProvider onClose={onClose}>
      <Form save={save} />
    </SettingsDraftProvider>,
  );
  fireEvent.click(screen.getByText("修改"));
  fireEvent.click(screen.getByText("关闭"));
  fireEvent.click(screen.getByText("继续编辑"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("关闭"));
  fireEvent.click(screen.getByText("放弃修改"));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});

test("retains the unsaved-settings dialog inertly while it exits", () => {
  const view = render(
    <SettingsDraftProvider onClose={() => undefined}>
      <Form save={async () => true} />
    </SettingsDraftProvider>,
  );
  fireEvent.click(screen.getByText("修改"));
  fireEvent.click(screen.getByText("关闭"));
  fireEvent.click(screen.getByText("继续编辑"));

  expect(
    view.container.querySelector('.motion-presence[data-motion-state="closing"][inert]'),
  ).not.toBeNull();
});

test("protects application exit and unregisters the guard when settings unmount", async () => {
  let guard: (() => Promise<boolean>) | undefined;
  const unregister = vi.fn();
  const registrar = {
    registerCloseGuard: vi.fn((_id: string, callback: () => Promise<boolean>) => {
      guard = callback;
      return unregister;
    }),
  };
  const view = render(
    <SettingsDraftProvider onClose={() => {}} closeGuardRegistrar={registrar}>
      <Form save={async () => true} />
    </SettingsDraftProvider>,
  );
  fireEvent.click(screen.getByText("修改"));
  let closing: Promise<boolean> | undefined;
  act(() => {
    closing = guard?.();
  });
  fireEvent.click(screen.getByText("继续编辑"));
  await expect(closing).resolves.toBe(false);
  act(() => {
    closing = guard?.();
  });
  fireEvent.click(screen.getByText("保存并关闭"));
  await expect(closing).resolves.toBe(true);
  view.unmount();
  expect(unregister).toHaveBeenCalledOnce();
});

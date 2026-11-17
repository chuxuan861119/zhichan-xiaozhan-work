import { createTrayController } from "./tray-controller.js";

function setup(available = true) {
  const window = {
    hide: vi.fn(),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    isMinimized: () => false,
    isDestroyed: () => false,
    close: vi.fn(),
  };
  const save = vi.fn();
  const update = vi.fn();
  const notify = vi.fn();
  const controller = createTrayController({
    window,
    available: () => available,
    requestSave: save,
    updateStatus: update,
    notify,
    showIntro: vi.fn(),
  });
  return { window, save, update, notify, controller };
}
test("hides without destroying, restores, and explicit exit bypasses hiding", () => {
  const { window, save, controller } = setup();
  expect(controller.tryHide()).toBe(true);
  expect(window.hide).toHaveBeenCalledOnce();
  expect(window.close).not.toHaveBeenCalled();
  expect(save).toHaveBeenCalledOnce();
  controller.open();
  expect(window.show).toHaveBeenCalledOnce();
  controller.quit();
  expect(window.show).toHaveBeenCalledTimes(2);
  expect(window.close).toHaveBeenCalledOnce();
  expect(controller.tryHide()).toBe(false);
});
test("never hides without a tray or when disabled", () => {
  expect(setup(false).controller.tryHide()).toBe(false);
  const { controller, window } = setup();
  controller.setEnabled(false);
  expect(controller.tryHide()).toBe(false);
  expect(window.hide).not.toHaveBeenCalled();
});
test("failed background save restores the window and ignores stale acknowledgements", () => {
  const { controller, save, window, notify } = setup();
  controller.tryHide();
  const token = save.mock.calls[0]![0];
  controller.saved("stale", false);
  expect(window.show).not.toHaveBeenCalled();
  controller.saved(token, false);
  expect(window.show).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledOnce();
});
test("cancelled exit restores normal close-to-tray behavior", () => {
  const { controller } = setup();
  controller.quit();
  controller.cancelQuit();
  expect(controller.tryHide()).toBe(true);
});
test("hiding again during a pending save schedules a fresh flush", () => {
  const { controller, save } = setup();
  controller.tryHide();
  const first = save.mock.calls[0]![0];
  controller.open();
  controller.tryHide();
  controller.saved(first, true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1]![0]).not.toBe(first);
  controller.dispose();
});

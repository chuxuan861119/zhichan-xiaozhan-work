import { afterEach, expect, test, vi } from "vitest";
import { createAuthorizationAttention } from "./authorization-attention.js";

afterEach(() => vi.useRealTimers());
function fixture(focused = false) {
  let click = () => {};
  const close = vi.fn();
  const cancel = vi.fn();
  const host = {
    isFocused: vi.fn(() => focused),
    notify: vi.fn((callback: () => void) => {
      click = callback;
      return close;
    }),
    requestAttention: vi.fn(() => cancel),
    openAuthorization: vi.fn(),
  };
  return {
    host,
    close,
    cancel,
    click: () => click(),
    attention: createAuthorizationAttention(host),
  };
}
test("background pairing alerts once, opens only on click, and clears when resolved", () => {
  const f = fixture();
  const requests = [{ pairId: "one", expiresAt: Date.now() + 30000 }];
  f.attention.update(requests);
  f.attention.update(requests);
  expect(f.host.notify).toHaveBeenCalledTimes(1);
  expect(f.host.requestAttention).toHaveBeenCalledTimes(1);
  expect(f.host.openAuthorization).not.toHaveBeenCalled();
  f.click();
  expect(f.host.openAuthorization).toHaveBeenCalledTimes(1);
  f.attention.update([]);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  f.click();
  expect(f.host.openAuthorization).toHaveBeenCalledTimes(1);
  f.attention.dispose();
});
test("foreground requests remain quiet, then alert once if the user switches away", () => {
  const f = fixture(true);
  const requests = [{ pairId: "one", expiresAt: Date.now() + 30000 }];
  f.attention.update(requests);
  expect(f.host.notify).not.toHaveBeenCalled();
  f.host.isFocused.mockReturnValue(false);
  f.attention.update(requests);
  expect(f.host.notify).toHaveBeenCalledTimes(1);
  f.host.isFocused.mockReturnValue(true);
  f.attention.update(requests);
  expect(f.close).toHaveBeenCalledTimes(1);
  f.host.isFocused.mockReturnValue(false);
  f.attention.update(requests);
  expect(f.host.notify).toHaveBeenCalledTimes(1);
  f.attention.dispose();
});
test("expiry and disposal clear reminders and make late notification clicks inert", () => {
  vi.useFakeTimers();
  const f = fixture();
  f.attention.update([{ pairId: "one", expiresAt: Date.now() + 100 }]);
  vi.advanceTimersByTime(101);
  expect(f.close).toHaveBeenCalledTimes(1);
  f.click();
  expect(f.host.openAuthorization).not.toHaveBeenCalled();
  f.attention.update([{ pairId: "two", expiresAt: Date.now() + 100 }]);
  f.attention.dispose();
  f.click();
  expect(f.host.openAuthorization).not.toHaveBeenCalled();
});
test("a notification failure leaves the icon fallback usable and does not open the application", () => {
  const f = fixture();
  f.host.notify.mockImplementation(() => {
    throw new Error("Notifications denied");
  });
  expect(() =>
    f.attention.update([{ pairId: "one", expiresAt: Date.now() + 10000 }]),
  ).not.toThrow();
  expect(f.host.requestAttention).toHaveBeenCalledTimes(1);
  expect(f.host.openAuthorization).not.toHaveBeenCalled();
  f.attention.dispose();
});

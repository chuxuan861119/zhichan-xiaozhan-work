import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AI_POLICY_VERSION } from "../../../shared/ai-correction/policy";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { AiConnectionSettings } from "./ai-connection-settings";

function finishReading() {
  const body = screen.getByRole("dialog").querySelector(".standard-dialog__body") as HTMLElement;
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 900 },
  });
  fireEvent.scroll(body, { target: { scrollTop: 600 } });
}

test("opening requires reading and agreement; cancelling never enables connections", async () => {
  const save = vi.fn(async () => true);
  render(<AiConnectionSettings preferences={DEFAULT_APP_SETTINGS} onSavePreferences={save} />);
  const toggle = screen.getByRole("checkbox", { name: "允许连接 AI 服务" });
  expect(toggle).toHaveProperty("checked", false);
  fireEvent.click(toggle);
  expect(save).not.toHaveBeenCalled();
  const accept = screen.getByRole("button", { name: "同意并开启" });
  expect(accept).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "暂不开启" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  finishReading();
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "我已阅读并同意 AI 使用协议与隐私说明" }),
    ).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意 AI 使用协议与隐私说明" }));
  fireEvent.click(screen.getByRole("button", { name: "同意并开启" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      aiConnectionsEnabled: true,
      aiPolicyAcceptedVersion: AI_POLICY_VERSION,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a failed save keeps AI disabled and the agreement dialog available", async () => {
  render(
    <AiConnectionSettings
      preferences={DEFAULT_APP_SETTINGS}
      onSavePreferences={async () => false}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "允许连接 AI 服务" }));
  finishReading();
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "我已阅读并同意 AI 使用协议与隐私说明" }),
    ).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意 AI 使用协议与隐私说明" }));
  fireEvent.click(screen.getByRole("button", { name: "同意并开启" }));
  await screen.findByText("保存失败，AI 连接未开启，请重试。");
  expect(screen.getByRole("checkbox", { name: "允许连接 AI 服务" })).toHaveProperty(
    "checked",
    false,
  );
});

test("a long agreement cannot be accepted before reaching the bottom, and must be read again after cancelling", async () => {
  const save = vi.fn(async () => true);
  render(<AiConnectionSettings preferences={DEFAULT_APP_SETTINGS} onSavePreferences={save} />);
  const toggle = screen.getByRole("checkbox", { name: "允许连接 AI 服务" });
  fireEvent.click(toggle);
  const body = screen.getByRole("dialog").querySelector(".standard-dialog__body") as HTMLElement;
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 900 },
  });
  fireEvent.scroll(body, { target: { scrollTop: 200 } });
  expect(
    screen.getByRole("checkbox", { name: "我已阅读并同意 AI 使用协议与隐私说明" }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "同意并开启" })).toHaveProperty("disabled", true);
  finishReading();
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意 AI 使用协议与隐私说明" }));
  fireEvent.click(screen.getByRole("button", { name: "暂不开启" }));
  fireEvent.click(toggle);
  expect(
    screen.getByRole("checkbox", { name: "我已阅读并同意 AI 使用协议与隐私说明" }),
  ).toHaveProperty("checked", false);
  expect(screen.getByRole("button", { name: "同意并开启" })).toHaveProperty("disabled", true);
  expect(save).not.toHaveBeenCalled();
});

test("closing an enabled connection does not ask for agreement", async () => {
  const save = vi.fn(async () => true);
  render(
    <AiConnectionSettings
      preferences={{ ...DEFAULT_APP_SETTINGS, aiConnectionsEnabled: true }}
      onSavePreferences={save}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "允许连接 AI 服务" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ aiConnectionsEnabled: false }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

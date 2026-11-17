import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MigrationPasswordStep } from "./migration-password-step";

const SECRET = "虚构迁移口令十二字符以上9!";

function CreatePasswordHarness() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordHint, setPasswordHint] = useState("");
  const [passwordRecorded, setPasswordRecorded] = useState(false);
  return (
    <MigrationPasswordStep
      mode="create"
      password={password}
      confirmPassword={confirmPassword}
      passwordHint={passwordHint}
      passwordRecorded={passwordRecorded}
      onPasswordChange={setPassword}
      onConfirmPasswordChange={setConfirmPassword}
      onPasswordHintChange={setPasswordHint}
      onPasswordRecordedChange={setPasswordRecorded}
    />
  );
}

test("uses protected password inputs and shows the non-recoverable warning", async () => {
  const user = userEvent.setup();
  const { container } = render(<CreatePasswordHarness />);

  const password = screen.getByLabelText<HTMLInputElement>("迁移密码");
  const confirmation = screen.getByLabelText<HTMLInputElement>("再次输入迁移密码");
  expect(password.type).toBe("password");
  expect(password.autocomplete).toBe("new-password");
  expect(confirmation.type).toBe("password");
  expect(screen.getByText("密码遗失后无法恢复").className).toContain(
    "migration-password-step__badge",
  );
  expect(container.querySelector(".migration-password-step__fields")).toBeTruthy();

  await user.type(password, SECRET);
  await user.type(confirmation, SECRET);
  expect(screen.queryByText(SECRET)).toBeNull();
  expect(screen.getByText(/密码强度：/u).textContent).not.toContain("尚未输入");

  await user.click(screen.getByRole("button", { name: "显示迁移密码" }));
  expect(password.type).toBe("text");
  expect(confirmation.type).toBe("text");
  await user.click(screen.getByRole("button", { name: "隐藏迁移密码" }));
  expect(password.type).toBe("password");
});

test("warns about Caps Lock and limits the public hint", async () => {
  const user = userEvent.setup();
  render(<CreatePasswordHarness />);
  const password = screen.getByLabelText("迁移密码");
  fireEvent.keyDown(password, { key: "CapsLock" });
  expect(screen.getByRole("status").textContent).toContain("大写锁定已开启");

  const hint = screen.getByLabelText<HTMLInputElement>("密码提示（可选）");
  expect(hint.maxLength).toBe(200);
  expect(
    screen.getByText("密码提示不加密，请勿填写密码本身、客户名或可直接推断密码的信息。"),
  ).toBeTruthy();
  await user.type(hint, "仅用于虚构测试的提示");
  expect(hint.value).toBe("仅用于虚构测试的提示");
});

test("requires an explicit record acknowledgement when creating a password", async () => {
  const user = userEvent.setup();
  render(<CreatePasswordHarness />);
  const acknowledgement = screen.getByRole<HTMLInputElement>("checkbox", {
    name: "我已记录并妥善保管迁移密码",
  });
  expect(acknowledgement.checked).toBe(false);
  await user.click(acknowledgement);
  expect(acknowledgement.checked).toBe(true);
});

test("shows a selected package hint without echoing an unlock password", async () => {
  const user = userEvent.setup();
  function UnlockHarness() {
    const [password, setPassword] = useState("");
    return (
      <MigrationPasswordStep
        mode="unlock"
        password={password}
        publicPasswordHint="虚构公开提示"
        onPasswordChange={setPassword}
      />
    );
  }
  render(<UnlockHarness />);
  const input = screen.getByLabelText<HTMLInputElement>("迁移密码");
  expect(input.autocomplete).toBe("current-password");
  expect(screen.getByText("虚构公开提示")).toBeTruthy();
  await user.type(input, SECRET);
  expect(screen.queryByText(SECRET)).toBeNull();
});

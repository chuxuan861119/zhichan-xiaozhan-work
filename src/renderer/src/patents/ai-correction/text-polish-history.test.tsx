import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import * as dialogs from "../../shared/app-dialog";
import { TextPolishHistory } from "./text-polish-history";

test("searches history, identifies running work and confirms deletion", async () => {
  const manage = vi.fn(async () => {});
  const confirm = vi.spyOn(dialogs, "confirmAppAction").mockResolvedValue(false);
  render(
    <TextPolishHistory
      items={[
        { conversationId: "a", title: "冷却结构", updatedAt: "2026-10-10", status: "running" },
        { conversationId: "b", title: "摘要", updatedAt: "2026-10-09", status: "completed" },
      ]}
      busy={false}
      onOpen={async () => {}}
      onManage={manage}
    />,
  );
  expect(screen.getByRole("button", { name: "删除冷却结构" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "停止冷却结构" }));
  await waitFor(() => expect(manage).toHaveBeenCalledWith("stop", "a"));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "摘要" } });
  expect(screen.queryByRole("button", { name: "打开冷却结构" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "删除摘要" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(manage).not.toHaveBeenCalledWith("delete", "b");
  confirm.mockResolvedValue(true);
  fireEvent.click(screen.getByRole("button", { name: "删除摘要" }));
  await waitFor(() => expect(manage).toHaveBeenCalledWith("delete", "b"));
  confirm.mockRestore();
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  AI_LOCAL_STORAGE_NOTICE,
  AI_OPERATOR_PRIVACY_NOTICE,
  AI_RESPONSIBILITY_NOTICE,
} from "../../../shared/ai-correction/policy";
import { AiDataPolicy } from "./ai-data-policy";

test("discloses operator and local boundaries together and opens only official policy documents", async () => {
  const openProviderDocs = vi.fn(async () => ({ ok: true, value: undefined }));
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { aiCorrection: { openProviderDocs } },
  });
  render(<AiDataPolicy />);
  fireEvent.click(screen.getByRole("button", { name: "AI 使用协议与隐私说明" }));
  expect(screen.getByText(AI_OPERATOR_PRIVACY_NOTICE)).toBeTruthy();
  expect(screen.getByText(AI_LOCAL_STORAGE_NOTICE)).toBeTruthy();
  expect(screen.getByText(AI_RESPONSIBILITY_NOTICE)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "DeepSeek 隐私政策 ↗" }));
  await waitFor(() =>
    expect(openProviderDocs).toHaveBeenCalledWith({ providerId: "deepseek", document: "privacy" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "DeepSeek 用户协议 ↗" }));
  await waitFor(() =>
    expect(openProviderDocs).toHaveBeenCalledWith({ providerId: "deepseek", document: "terms" }),
  );
});

test("reports an official document opening failure without hiding the disclosure", async () => {
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      aiCorrection: {
        openProviderDocs: async () => ({ ok: false, error: { message: "浏览器无法打开" } }),
      },
    },
  });
  render(<AiDataPolicy />);
  fireEvent.click(screen.getByRole("button", { name: "AI 使用协议与隐私说明" }));
  fireEvent.click(screen.getByRole("button", { name: "DeepSeek 隐私政策 ↗" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "浏览器无法打开");
  expect(screen.getByText(AI_LOCAL_STORAGE_NOTICE)).toBeTruthy();
});

test("keeps the policy behind one button and supports closing and reopening the complete dialog", async () => {
  const openProviderDocs = vi.fn(async () => ({ ok: false, error: { message: "无法打开政策" } }));
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { aiCorrection: { openProviderDocs } },
  });
  render(<AiDataPolicy />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByText(AI_OPERATOR_PRIVACY_NOTICE)).toBeNull();
  const trigger = screen.getByRole("button", { name: "AI 使用协议与隐私说明" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "AI 使用协议与隐私说明" });
  expect(within(dialog).getByText(AI_OPERATOR_PRIVACY_NOTICE)).toBeDefined();
  expect(within(dialog).getByText(AI_LOCAL_STORAGE_NOTICE)).toBeDefined();
  expect(within(dialog).getByRole("heading", { name: "数据发送与控制" })).toBeDefined();
  fireEvent.click(within(dialog).getByRole("button", { name: "DeepSeek 隐私政策 ↗" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "无法打开政策");
  expect(openProviderDocs).toHaveBeenCalledWith({ providerId: "deepseek", document: "privacy" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog")).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

import { render, screen } from "@testing-library/react";
import { FileOperationStatus } from "./file-operation-status";

test("announces the current file operation in a modal status", () => {
  render(<FileOperationStatus message="正在读取并识别 DOCX…" />);

  expect(screen.getByRole("dialog", { name: "正在处理文件" })).toBeDefined();
  expect(screen.getByRole("status").textContent).toBe("正在读取并识别 DOCX…");
});

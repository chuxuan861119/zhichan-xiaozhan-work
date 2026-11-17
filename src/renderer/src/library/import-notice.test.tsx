import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useImportNotice } from "./import-notice";

function Harness({ onImport = () => {} }: { onImport?: () => void }) {
  const notice = useImportNotice();
  return (
    <>
      {(["zip", "patdoc", "docx"] as const).map((format) => (
        <button
          key={format}
          type="button"
          onClick={async () => {
            if (await notice.request(format)) onImport();
          }}
        >
          {format}
        </button>
      ))}
      {notice.dialog}
    </>
  );
}

beforeEach(() => localStorage.clear());

test("cancel keeps first-use notice pending; continue remembers each format across remounts", async () => {
  const onImport = vi.fn();
  const view = render(<Harness onImport={onImport} />);
  fireEvent.click(screen.getByText("zip"));
  expect(screen.getByRole("dialog", { name: "压缩包导入须知" })).toBeDefined();
  expect(onImport).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "取消" })));
  expect(onImport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("zip"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "继续导入" })));
  expect(onImport).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<Harness onImport={onImport} />);
  await act(async () => fireEvent.click(screen.getByText("zip")));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onImport).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByText("patdoc"));
  expect(screen.getByRole("dialog", { name: "PATDOC 导入须知" })).toBeDefined();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "关闭PATDOC 导入须知" })),
  );
  fireEvent.click(screen.getByText("docx"));
  expect(screen.getByRole("dialog", { name: "DOCX 导入须知" })).toBeDefined();
});

test("repeated clicks do not create multiple imports; unmount cancels the pending request", async () => {
  const onImport = vi.fn();
  const view = render(<Harness onImport={onImport} />);
  await act(async () => {
    fireEvent.click(screen.getByText("docx"));
    fireEvent.click(screen.getByText("docx"));
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "继续导入" })));
  expect(onImport).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("zip"));
  await act(async () => view.unmount());
  expect(onImport).toHaveBeenCalledTimes(1);
});

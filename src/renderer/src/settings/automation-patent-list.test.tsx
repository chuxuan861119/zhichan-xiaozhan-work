import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { listAuthorizationPatents } from "./automation-patent-list";
import { ScopeEditor } from "./automation-settings";

test("authorization loads only active patents and hides stale trash entries in both scope editors", async () => {
  const active = { patentId: "active", name: "正常专利", deletedAt: null } as LibraryPatentSummary;
  const trash = {
    patentId: "trash",
    name: "回收站专利",
    deletedAt: "2026-10-03",
  } as LibraryPatentSummary;
  const list = vi.fn(async () => ({ ok: true, value: [active, trash] }));
  window.patentApi = { patents: { list } } as unknown as PatentApi;
  expect(await listAuthorizationPatents()).toEqual([active]);
  expect(list.mock.calls).toEqual([["active"]]);
  render(
    <ScopeEditor
      patents={[active, trash]}
      scope={{ patents: {}, createLimit: 0, workspace: {} }}
      onChange={() => {}}
    />,
  );
  expect(screen.getByLabelText("权限 正常专利")).toBeDefined();
  expect(screen.queryByText("回收站专利")).toBeNull();
});

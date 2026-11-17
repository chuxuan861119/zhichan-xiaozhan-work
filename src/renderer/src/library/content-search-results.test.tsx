import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import {
  ContentSearchResults,
  type ContentSearchResultsSnapshot,
  HighlightSearchText,
} from "./content-search-results";

const ready = {
  indexVersion: "index-1",
  sourceVersion: "source-1",
  enabled: false,
  running: false,
  completed: 1,
  total: 1,
  updatedAt: null,
  error: false,
  incomplete: false,
};

it("highlights original Unicode characters without shifting the offset", () => {
  const { container } = render(<HighlightSearchText text={"İX\nµ μ"} query="X" />);
  expect(container.querySelector("mark")?.textContent).toBe("X");
});

it("keeps expanded details across unrelated commits and background index updates", async () => {
  let sourceVersion = "source-1",
    indexVersion = "index-1";
  const request = vi.fn(async (input: { action: string }) => ({
    ok: true,
    value: {
      ...ready,
      sourceVersion,
      indexVersion,
      hits: [
        {
          patentId: "p1",
          books: [
            {
              kind: "description",
              count: 4,
              snippets:
                input.action === "search-details"
                  ? ["词一", "词二", "词三", "词四"]
                  : ["词一", "词二", "词三"],
            },
          ],
        },
      ],
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchResults query="词" patents={[patent]} type="all" onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "展开全部 4 处" }));
  await screen.findByRole("button", { name: /说明书.*词四/ });
  sourceVersion = "source-2";
  await waitFor(
    () =>
      expect(request.mock.calls.filter(([r]) => r.action === "status").length).toBeGreaterThan(0),
    { timeout: 3000 },
  );
  expect(request.mock.calls.filter(([r]) => r.action === "search")).toHaveLength(1);
  indexVersion = "index-2";
  await screen.findByRole("button", { name: "刷新搜索结果" }, { timeout: 3000 });
  expect(screen.getByRole("button", { name: "收起全部匹配" })).toBeDefined();
  expect(screen.getByRole("button", { name: /说明书.*词四/ })).toBeDefined();
});

it("refreshes active results after a patent revision changes", async () => {
  let updated = false;
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      ...ready,
      sourceVersion: updated ? "source-2" : "source-1",
      hits: updated
        ? []
        : [
            {
              patentId: "p1",
              books: [{ kind: "description", count: 1, snippets: ["旧关键词正文"] }],
            },
          ],
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  const { rerender } = render(
    <ContentSearchResults query="关键词" patents={[patent]} type="all" onOpen={() => {}} />,
  );
  await screen.findByRole("button", { name: /旧关键词正文/ });
  updated = true;
  rerender(
    <ContentSearchResults
      query="关键词"
      patents={[{ ...patent, revision: patent.revision + 1 }]}
      type="all"
      onOpen={() => {}}
    />,
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: /旧关键词正文/ })).toBeNull());
});

it("retains results until explicit refresh when background indexing changes", async () => {
  let updated = false;
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      ...ready,
      indexVersion: updated ? "index-2" : "index-1",
      hits: updated
        ? []
        : [
            {
              patentId: "p1",
              books: [{ kind: "description", count: 1, snippets: ["旧关键词正文"] }],
            },
          ],
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchResults query="关键词" patents={[patent]} type="all" onOpen={() => {}} />);
  await screen.findByRole("button", { name: /旧关键词正文/ });
  updated = true;
  fireEvent.click(await screen.findByRole("button", { name: "刷新搜索结果" }, { timeout: 4000 }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /旧关键词正文/ })).toBeNull(), {
    timeout: 4000,
  });
});
it("ignores details arriving from an older search after a revision refresh", async () => {
  let updated = false;
  let resolveDetails!: (value: unknown) => void;
  const oldDetails = new Promise<unknown>((resolve) => {
    resolveDetails = resolve;
  });
  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === "search-details") return oldDetails;
    return {
      ok: true,
      value: {
        ...ready,
        hits: updated
          ? []
          : [
              {
                patentId: "p1",
                books: [
                  { kind: "description", count: 4, snippets: ["结果一", "结果二", "结果三"] },
                ],
              },
            ],
      },
    };
  });
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  const onSnapshotChange = vi.fn();
  const { rerender } = render(
    <ContentSearchResults
      query="结果"
      patents={[patent]}
      type="all"
      onOpen={() => {}}
      onSnapshotChange={onSnapshotChange}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "展开全部 4 处" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "search-details" })),
  );
  updated = true;
  rerender(
    <ContentSearchResults
      query="结果"
      patents={[{ ...patent, revision: 2 }]}
      type="all"
      onOpen={() => {}}
      onSnapshotChange={onSnapshotChange}
    />,
  );
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已找到 0 项专利"));
  await act(async () =>
    resolveDetails({
      ok: true,
      value: {
        ...ready,
        hits: [
          {
            patentId: "p1",
            books: [
              { kind: "description", count: 4, snippets: ["结果一", "结果二", "结果三", "结果四"] },
            ],
          },
        ],
      },
    }),
  );
  expect(onSnapshotChange.mock.lastCall?.[0].details).toEqual({});
  expect(screen.queryByRole("button", { name: /结果四/ })).toBeNull();
});
it("does not retrigger continuation when a parent saves the result snapshot", async () => {
  const searches: unknown[] = [];
  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === "search") searches.push(input);
    return { ok: true, value: { ...ready, hits: [], hasMore: true, nextCursor: "last" } };
  });
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  function Parent() {
    const [snapshot, setSnapshot] = useState<ContentSearchResultsSnapshot | null>(null);
    return (
      <ContentSearchResults
        query="词"
        patents={[]}
        type="all"
        onOpen={() => {}}
        snapshot={snapshot}
        onSnapshotChange={setSnapshot}
      />
    );
  }
  render(<Parent />);
  fireEvent.click(await screen.findByRole("button", { name: "继续搜索" }));
  await waitFor(() => expect(searches.length).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(searches).toHaveLength(2);
});
it("refreshes a restored snapshot when the source version has changed", async () => {
  const request = vi.fn(async (input: { action: string }) => ({
    ok: true,
    value: { ...ready, sourceVersion: "source-2", hits: [] },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(
    <ContentSearchResults
      query="关键词"
      patents={[patent]}
      type="all"
      onOpen={() => {}}
      snapshot={{
        query: "关键词",
        type: "all",
        state: {
          ...ready,
          hits: [
            {
              patentId: "p1",
              books: [{ kind: "description", count: 1, snippets: ["旧关键词正文"] }],
            },
          ],
        },
        error: false,
        limit: 30,
        expandedPatentIds: [],
        details: {},
      }}
    />,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "search" })),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: /旧关键词正文/ })).toBeNull());
});
it("does not append detail snippets when the index version changes", async () => {
  const request = vi.fn(async (input: { action: string }) => ({
    ok: true,
    value:
      input.action === "search-details"
        ? { ...ready, versionChanged: true, hits: [] }
        : {
            ...ready,
            hits: [
              {
                patentId: "p1",
                books: [
                  { kind: "description", count: 4, snippets: ["结果一", "结果二", "结果三"] },
                ],
              },
            ],
          },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchResults query="结果" patents={[patent]} type="all" onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "展开全部 4 处" }));
  expect(await screen.findByRole("button", { name: "刷新搜索结果" })).toBeDefined();
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ action: "search-details", indexVersion: "index-1" }),
  );
});
it("expands cross-book matches even when all snippets are already loaded, with separate numbered headings", async () => {
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      ...ready,
      hits: [
        {
          patentId: "p1",
          books: [
            { kind: "claims", count: 2, snippets: ["结果一", "结果二"] },
            { kind: "description", count: 2, snippets: ["结果三", "结果四"] },
          ],
        },
      ],
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  const { container } = render(
    <ContentSearchResults query="结果" patents={[patent]} type="all" onOpen={() => {}} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "展开全部 4 处" }));
  expect(screen.getByRole("button", { name: /说明书.*结果四/ })).toBeDefined();
  expect(
    [...container.querySelectorAll(".content-search-match-heading > span:first-child")].map(
      (el) => el.textContent,
    ),
  ).toEqual(["1.1", "1.2", "1.3", "1.4"]);
  expect(
    container.querySelector(".content-search-snippet .content-search-match-heading"),
  ).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
it("reports cache-query failures rather than saying there are no matches", async () => {
  const request = vi.fn(async () => ({
    ok: true,
    value: { ...ready, error: true, searchError: true, hits: [] },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchResults query="词" patents={[patent]} type="all" onOpen={() => {}} />);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("正文搜索暂不可用"));
  expect(screen.queryByText(/暂无匹配结果/)).toBeNull();
  expect(screen.getByRole("button", { name: "重试搜索" })).toBeDefined();
});

it("retries the same continuation cursor after a failed next page", async () => {
  const searches: unknown[] = [];
  let calls = 0;
  const request = vi.fn(async (input: { action: string; after?: string }) => {
    if (input.action !== "search") return { ok: true, value: ready };
    searches.push(input);
    calls++;
    if (calls === 2) return { ok: false };
    return {
      ok: true,
      value: { ...ready, hits: [], hasMore: calls === 1, nextCursor: "last-first-page" },
    };
  });
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchResults query="词" patents={[patent]} type="all" onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "继续搜索" }));
  fireEvent.click(await screen.findByRole("button", { name: "重试搜索" }));
  await waitFor(() => expect(searches).toHaveLength(3));
  expect(searches[1]).toMatchObject({ after: "last-first-page" });
  expect(searches[2]).toMatchObject({ after: "last-first-page" });
});

it("cancels work on unmount and sends the selected patent type to the worker", async () => {
  const request = vi.fn(async () => ({ ok: true, value: { ...ready, hits: [] } }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  const view = render(
    <ContentSearchResults query="词" patents={[patent]} type="utility-model" onOpen={() => {}} />,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ action: "search", patentType: "utility-model" }),
    ),
  );
  view.unmount();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel-search" }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const patent = {
  patentId: "p1",
  revision: 1,
  name: "输送装置",
  customer: "客户甲",
  patentType: "invention",
  recoveryState: "healthy",
} as LibraryPatentSummary;
it("groups snippets by patent, highlights Chinese text, and opens the matched book", async () => {
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      enabled: false,
      running: false,
      completed: 1,
      total: 1,
      updatedAt: null,
      error: false,
      incomplete: true,
      hits: [
        {
          patentId: "p1",
          books: [{ kind: "description", count: 1, snippets: ["采用螺旋输送结构"] }],
        },
      ],
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  const open = vi.fn();
  render(<ContentSearchResults query="螺旋" patents={[patent]} type="all" onOpen={open} />);
  await screen.findByRole("button", { name: /说明书.*采用螺旋/ });
  expect(document.querySelector("mark")?.textContent).toBe("螺旋");
  expect(screen.getByRole("status").textContent).toContain("部分内容待更新");
  fireEvent.click(screen.getByRole("button", { name: /说明书.*采用螺旋/ }));
  expect(open).toHaveBeenCalledWith(
    patent,
    {
      kind: "description",
      query: "螺旋",
      snippet: "采用螺旋输送结构",
    },
    "p1:description-采用螺旋输送结构-1",
  );
  fireEvent.click(screen.getByRole("button", { name: "输送装置" }));
  expect(open).toHaveBeenLastCalledWith(
    patent,
    { kind: "description", query: "螺旋", snippet: "采用螺旋输送结构" },
    "p1:title",
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ action: "search", query: "螺旋" }),
  );
});
it("preserves metadata matches on search failure", async () => {
  const request = vi.fn(async () => ({ ok: false }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchResults query="客户甲" patents={[patent]} type="all" onOpen={() => {}} />);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("正文搜索暂不可用"));
  expect(screen.getByRole("button", { name: "输送装置" })).toBeDefined();
});

it("restores cached details and expanded snippets without searching again", async () => {
  const request = vi.fn(async (input: { action: string }) => ({
    ok: true,
    value:
      input.action === "search" || input.action === "search-details"
        ? {
            ...ready,
            hits: [
              {
                patentId: "p1",
                books: [
                  {
                    kind: "description" as const,
                    count: 4,
                    snippets:
                      input.action === "search"
                        ? ["结果一", "结果二", "结果三"]
                        : ["结果一", "结果二", "结果三", "结果四"],
                  },
                ],
              },
            ],
          }
        : ready,
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  let snapshot: ContentSearchResultsSnapshot | null = null;
  const first = render(
    <ContentSearchResults
      query="结果"
      patents={[patent]}
      type="all"
      onOpen={() => {}}
      onSnapshotChange={(next) => {
        snapshot = next;
      }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "展开全部 4 处" }));
  await screen.findByRole("button", { name: /说明书.*结果四/ });
  await waitFor(() => expect(snapshot?.details.p1?.books[0]?.snippets).toHaveLength(4));
  first.unmount();

  render(
    <ContentSearchResults
      query="结果"
      patents={[patent]}
      type="all"
      onOpen={() => {}}
      snapshot={snapshot}
    />,
  );

  expect(screen.getByRole("button", { name: /说明书.*结果四/ })).toBeDefined();
  expect(screen.getByRole("button", { name: "收起全部匹配" })).toBeDefined();
  expect(request.mock.calls.filter(([input]) => input.action === "search")).toHaveLength(1);
  expect(request.mock.calls.filter(([input]) => input.action === "search-details")).toHaveLength(1);
});

it("treats rapid double clicks on a result as one open action", async () => {
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      ...ready,
      hits: [
        {
          patentId: "p1",
          books: [{ kind: "description", count: 1, snippets: ["采用螺旋输送结构"] }],
        },
      ],
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  const open = vi.fn();
  render(<ContentSearchResults query="螺旋" patents={[patent]} type="all" onOpen={open} />);
  const result = await screen.findByRole("button", { name: /说明书.*采用螺旋/ });

  fireEvent.click(result, { detail: 1 });
  fireEvent.click(result, { detail: 2 });
  fireEvent.doubleClick(result, { detail: 2 });

  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(open).toHaveBeenCalledOnce();
});

it("loads complete match details on demand with a clear expand control", async () => {
  const request = vi.fn(async (input: { action: string }) => ({
    ok: true,
    value:
      input.action === "search-details"
        ? {
            ...ready,
            hits: [
              {
                patentId: "p1",
                books: [
                  {
                    kind: "description",
                    count: 6,
                    snippets: ["结果一", "结果二", "结果三", "结果四", "结果五", "结果六"],
                  },
                ],
              },
            ],
            hasMore: false,
          }
        : {
            ...ready,
            hits: [
              {
                patentId: "p1",
                books: [
                  {
                    kind: "description",
                    count: 6,
                    snippets: ["结果一", "结果二", "结果三"],
                  },
                ],
              },
            ],
          },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchResults query="结果" patents={[patent]} type="all" onOpen={() => {}} />);

  const expand = await screen.findByRole("button", { name: "展开全部 6 处" });
  expect(expand.classList.contains("content-search-expand")).toBe(true);
  expect(request.mock.calls.some(([input]) => input.action === "search-details")).toBe(false);
  fireEvent.click(expand);

  expect(await screen.findByRole("button", { name: /说明书.*结果六/ })).toBeDefined();
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "search-details",
      query: "结果",
      patentId: "p1",
      offset: 0,
    }),
  );
  expect(screen.getByRole("button", { name: "收起全部匹配" })).toBeDefined();
});

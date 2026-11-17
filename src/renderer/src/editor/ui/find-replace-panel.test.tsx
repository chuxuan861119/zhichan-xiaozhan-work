import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Content, Editor } from "@tiptap/core";
import { useState } from "react";
import { createPatentExtensions } from "../extensions";
import { findLiteralMatches, searchPreparedChunks } from "../find-replace";
import type { FindSearchRequest } from "../find-search-task";
import { FindReplacePanel } from "./find-replace-panel";

beforeEach(() => {
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      active = true;
      postMessage(request: FindSearchRequest) {
        setTimeout(() => {
          if (this.active)
            this.onmessage?.({
              data: searchPreparedChunks(request.chunks, request.query, request.options),
            } as MessageEvent);
        }, 0);
      }
      terminate() {
        this.active = false;
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function editorWith(content: Content) {
  return new Editor({ extensions: createPatentExtensions(), content });
}

async function clickReady(element: Element) {
  await waitFor(() => expect((element as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(element);
}

function panelProps(editor: Editor, overrides: Record<string, unknown> = {}) {
  return {
    editor,
    mode: "find" as const,
    query: "",
    replacement: "",
    onClose: vi.fn(),
    ...overrides,
  };
}

/** The action button is the one without an aria-pressed attribute. */
function replaceActionButton() {
  return screen
    .getAllByRole("button", { name: "替换" })
    .find((button) => button.getAttribute("aria-pressed") === null);
}

describe("find/replace rail panel", () => {
  test.each(["query", "document", "composition"])(
    "does not apply queued navigation after %s changes",
    async (change) => {
      const editor = editorWith("技术 方案 技术");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const props = panelProps(editor, { query: "技术" });
      const { rerender, unmount } = render(<FindReplacePanel {...props} />);
      fireEvent.keyDown(screen.getByRole("textbox", { name: "查找内容" }), {
        key: "Enter",
        isComposing: change === "composition",
      });
      if (change === "query") {
        rerender(<FindReplacePanel {...props} query="方案" />);
        rerender(<FindReplacePanel {...props} />);
      } else if (change === "document") {
        act(() => editor.commands.insertContent("新"));
      }
      const selection = { from: editor.state.selection.from, to: editor.state.selection.to };
      await waitFor(() => expect(screen.queryByText("正在查找全部内容…")).toBeNull());
      expect({ from: editor.state.selection.from, to: editor.state.selection.to }).toEqual(
        selection,
      );
      unmount();
      editor.destroy();
    },
  );
  test.each([false, true])(
    "queues Enter until the search completes (previous: %s)",
    async (previous) => {
      const editor = editorWith("技术 方案 技术");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const { unmount } = render(<FindReplacePanel {...panelProps(editor, { query: "技术" })} />);
      fireEvent.keyDown(screen.getByRole("textbox", { name: "查找内容" }), {
        key: "Enter",
        shiftKey: previous,
      });
      const expected = findLiteralMatches(editor.state.doc, "技术")[previous ? 1 : 0];
      await waitFor(() => expect(editor.state.selection.to).toBe(expected?.to));
      unmount();
      editor.destroy();
    },
  );
  test("does not carry pending replacement navigation into a different query", async () => {
    const requests: Array<() => void> = [];
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        active = true;
        postMessage(request: FindSearchRequest) {
          requests.push(() => {
            if (this.active)
              this.onmessage?.({
                data: searchPreparedChunks(request.chunks, request.query, request.options),
              } as MessageEvent);
          });
        }
        terminate() {
          this.active = false;
        }
      },
    );
    const editor = editorWith("技术 方案 技术 方案");
    const first = findLiteralMatches(editor.state.doc, "技术")[0];
    if (!first) throw new Error("Missing match");
    editor.commands.setTextSelection(first);
    const props = panelProps(editor, { mode: "replace", query: "技术", replacement: "方法" });
    const { rerender, unmount } = render(<FindReplacePanel {...props} />);
    act(() => requests.shift()?.());
    act(() => editor.commands.setTextSelection(first));
    fireEvent.click(replaceActionButton() as HTMLButtonElement);
    expect(editor.getText()).toContain("方法");
    rerender(<FindReplacePanel {...props} query="方案" />);
    act(() => {
      for (const finish of requests.splice(0)) finish();
    });
    await waitFor(() => expect(screen.queryByText("正在查找全部内容…")).toBeNull());
    expect(screen.queryByText(/已替换 1 处/)).toBeNull();
    expect(editor.getText()).toContain("方法");
    unmount();
    editor.destroy();
  });
  test("does not report no matches or enable replacement while the worker is unfinished", async () => {
    const terminate = vi.fn();
    vi.stubGlobal(
      "Worker",
      class {
        postMessage() {}
        terminate = terminate;
      },
    );
    const editor = editorWith("技术 技术");
    const { rerender, unmount } = render(
      <FindReplacePanel {...panelProps(editor, { query: "技术", mode: "replace" })} />,
    );
    expect(screen.getByText("正在查找全部内容…")).toBeTruthy();
    expect(screen.queryByText("未找到")).toBeNull();
    expect((screen.getByRole("button", { name: "全部替换" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<FindReplacePanel {...panelProps(editor, { query: "方案", mode: "replace" })} />);
    expect(terminate).toHaveBeenCalled();
    unmount();
    editor.destroy();
  });
  test("dismisses the special character picker only when the outside backdrop is clicked", async () => {
    const editor = editorWith("技术方案");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor)} />);
    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    const dialog = screen.getByRole("dialog", { name: "选择查找特殊字符" });
    fireEvent.click(dialog.querySelector("header")!);
    expect(screen.getByRole("dialog", { name: "选择查找特殊字符" })).toBe(dialog);
    fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole("dialog", { name: "选择查找特殊字符" })).toBeNull();
    unmount();
    editor.destroy();
  });
  test("keeps repeated Enter navigation in the query input without editing the document", async () => {
    const editor = editorWith("技术 技术 技术");
    document.body.append(editor.view.dom);
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { query: "技术" })} />);
    const query = screen.getByRole("textbox", { name: "查找内容" });
    const original = editor.getText();
    await screen.findByText("0/3");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(editor.state.selection.from).toBe(1));
    // Tiptap schedules focus in an animation frame.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(document.activeElement).toBe(query);
    await userEvent.keyboard("{Enter}");
    expect(editor.state.selection.from).toBe(4);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(editor.state.selection.from).toBe(1);
    expect(editor.getText()).toEqual(original);
    unmount();
    editor.destroy();
  });

  test("marks the panel as a transient function-rail component", () => {
    const editor = editorWith("技术方案");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor)} />);

    expect(screen.getByRole("search", { name: "查找和替换" }).className).toContain(
      "function-rail-transient-panel",
    );

    editor.destroy();
    unmount();
  });

  test("shows 未找到 when the query has no matches and disables navigation", async () => {
    const editor = editorWith("技术 方案");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { query: "不存在" })} />);
    expect(await screen.findByText("未找到")).toBeTruthy();
    expect((screen.getByRole("button", { name: "上一个" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "下一个" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    editor.destroy();
    unmount();
  });

  test("shows match count and advances the current index on next", async () => {
    const editor = editorWith("技术 技术 技术");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { query: "技术" })} />);
    expect(await screen.findByText("0/3")).toBeTruthy();
    await clickReady(screen.getByRole("button", { name: "下一个" }));
    await waitFor(() => expect(screen.getByText("1/3")).toBeTruthy());
    editor.destroy();
    unmount();
  });

  test("highlights every match and distinguishes the active match", async () => {
    const editor = editorWith("技术 技术 技术");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { query: "技术" })} />);
    await waitFor(() =>
      expect(editor.view.dom.querySelectorAll(".find-replace-match")).toHaveLength(3),
    );
    await clickReady(screen.getByRole("button", { name: "下一个" }));
    await waitFor(() =>
      expect(editor.view.dom.querySelectorAll(".find-replace-match.is-active")).toHaveLength(1),
    );
    unmount();
    expect(editor.view.dom.querySelectorAll(".find-replace-match")).toHaveLength(0);
    editor.destroy();
  });

  test("scrolls the next match into view when the editor already has focus", async () => {
    const editor = editorWith("技术 技术 技术");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { query: "技术" })} />);
    editor.view.focus();
    const dispatch = vi.spyOn(editor.view, "dispatch");

    await clickReady(screen.getByRole("button", { name: "下一个" }));

    expect(dispatch.mock.calls.some(([transaction]) => transaction.scrolledIntoView)).toBe(true);
    dispatch.mockRestore();
    editor.destroy();
    unmount();
  });

  test("switches modes via the segmented control", async () => {
    const editor = editorWith("技术");
    const onModeChange = vi.fn();
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { onModeChange })} />);
    await userEvent.click(screen.getByRole("button", { name: "替换" }));
    expect(onModeChange).toHaveBeenCalledWith("replace");
    editor.destroy();
    unmount();
  });

  test("closes through the close button", async () => {
    const editor = editorWith("技术");
    const onClose = vi.fn();
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { onClose })} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭查找" }));
    expect(onClose).toHaveBeenCalledOnce();
    editor.destroy();
    unmount();
  });

  test("closes with Escape from the query field without propagating the shortcut", () => {
    const editor = editorWith("技术");
    const onClose = vi.fn();
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { onClose })} />);
    const outerKeyDown = vi.fn();
    window.addEventListener("keydown", outerKeyDown);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    screen.getByRole("textbox", { name: "查找内容" }).dispatchEvent(event);
    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(outerKeyDown).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outerKeyDown);
    editor.destroy();
    unmount();
  });

  test("closes with Escape while the replacement field is focused", () => {
    const editor = editorWith("技术");
    const onClose = vi.fn();
    const { unmount } = render(
      <FindReplacePanel {...panelProps(editor, { mode: "replace", onClose })} />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "替换为" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    editor.destroy();
    unmount();
  });

  test("replaces the current match and advances to the next one", async () => {
    const editor = editorWith("技术 技术");
    const { unmount } = render(
      <FindReplacePanel
        {...panelProps(editor, {
          mode: "replace",
          query: "技术",
          replacement: "方案",
        })}
      />,
    );
    await clickReady(screen.getByRole("button", { name: "下一个" }));
    const replaceAction = replaceActionButton();
    if (!replaceAction) throw new Error("fixture");
    await clickReady(replaceAction);
    expect(editor.getText()).toBe("方案 技术");
    await waitFor(() => expect(screen.getByText("1/1")).toBeTruthy());
    editor.destroy();
    unmount();
  });

  test("restores the editor caret after replacing the final match", async () => {
    const editor = editorWith("技术");
    document.body.append(editor.view.dom);
    const { unmount } = render(
      <FindReplacePanel
        {...panelProps(editor, {
          mode: "replace",
          query: "技术",
          replacement: "方案",
        })}
      />,
    );
    await clickReady(screen.getByRole("button", { name: "下一个" }));
    const replaceAction = replaceActionButton();
    if (!replaceAction) throw new Error("fixture");

    await clickReady(replaceAction);

    await waitFor(() => expect(editor.isFocused).toBe(true));
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(3);
    editor.commands.insertContent("继续输入");
    expect(editor.getText()).toBe("方案继续输入");
    editor.view.dom.remove();
    editor.destroy();
    unmount();
  });

  test("replaces all only after confirmation", async () => {
    const editor = editorWith("技术 技术 技术");
    const { unmount } = render(
      <FindReplacePanel
        {...panelProps(editor, {
          mode: "replace",
          query: "技术",
          replacement: "方案",
        })}
      />,
    );
    await clickReady(screen.getByRole("button", { name: "全部替换" }));
    expect(screen.getByRole("dialog", { name: "请确认" }).textContent).toContain(
      "即将替换 3 处，是否继续？",
    );
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(editor.getText()).toBe("技术 技术 技术");
    expect(screen.getByText("已取消替换")).toBeTruthy();

    await clickReady(screen.getByRole("button", { name: "全部替换" }));
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(editor.getText()).toBe("方案 方案 方案"));
    expect(screen.getByText("已替换 3 处")).toBeTruthy();
    editor.destroy();
    unmount();
  });

  test("does not replace a document changed while confirmation is open", async () => {
    const editor = editorWith("技术 技术");
    const { unmount } = render(
      <FindReplacePanel
        {...panelProps(editor, {
          mode: "replace",
          query: "技术",
          replacement: "方案",
        })}
      />,
    );
    await clickReady(screen.getByRole("button", { name: "全部替换" }));
    editor.commands.setContent("技术 新内容");
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(editor.getText()).toBe("技术 新内容");
    expect(screen.getByText("文档已变化，请重新查找后替换")).toBeTruthy();
    editor.destroy();
    unmount();
  });

  test("does not replace the previous editor after the panel changes documents", async () => {
    const editor = editorWith("技术 技术");
    const nextEditor = editorWith("技术 新文档");
    const options = { mode: "replace", query: "技术", replacement: "方案" };
    const { rerender, unmount } = render(<FindReplacePanel {...panelProps(editor, options)} />);
    await clickReady(screen.getByRole("button", { name: "全部替换" }));
    rerender(<FindReplacePanel {...panelProps(nextEditor, options)} />);
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(editor.getText()).toBe("技术 技术");
    expect(nextEditor.getText()).toBe("技术 新文档");
    editor.destroy();
    nextEditor.destroy();
    unmount();
  });

  test("recomputes matches as the controlled query changes", async () => {
    const editor = editorWith("技术 技术 方案");
    function Harness() {
      const [query, setQuery] = useState("技术");
      return <FindReplacePanel {...panelProps(editor, { query, onQueryChange: setQuery })} />;
    }
    const { unmount } = render(<Harness />);
    expect(await screen.findByText("0/2")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "查找内容" }), {
      target: { value: "方案" },
    });
    expect(await screen.findByText("0/1")).toBeTruthy();
    editor.destroy();
    unmount();
  });

  test("expands capture groups when replacing the current match", async () => {
    const editor = editorWith("技术 技术");
    const { unmount } = render(
      <FindReplacePanel
        {...panelProps(editor, {
          mode: "replace",
          query: "(技)术",
          replacement: "[$1]",
          options: { useRegex: true },
        })}
      />,
    );
    await clickReady(screen.getByRole("button", { name: "下一个" }));
    const replaceAction = replaceActionButton();
    if (!replaceAction) throw new Error("fixture");
    await clickReady(replaceAction);
    expect(editor.getText()).toBe("[技] 技术");
    editor.destroy();
    unmount();
  });

  test("switches among literal, Word wildcard, and regex search modes", async () => {
    const editor = editorWith("图1 图22");
    const onOptionsChange = vi.fn();
    const { unmount } = render(<FindReplacePanel {...panelProps(editor, { onOptionsChange })} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "查找方式" }), "wildcard");
    expect(onOptionsChange).toHaveBeenCalledWith(
      expect.objectContaining({ searchMode: "wildcard" }),
    );
    editor.destroy();
    unmount();
  });

  test("uses one special-character button and inserts into the initially focused query field", async () => {
    const editor = editorWith("图1");
    function Harness() {
      const [query, setQuery] = useState("图");
      const [replacement, setReplacement] = useState("");
      return (
        <FindReplacePanel
          {...panelProps(editor, {
            mode: "replace",
            query,
            replacement,
            onQueryChange: setQuery,
            onReplacementChange: setReplacement,
          })}
        />
      );
    }
    const { unmount } = render(<Harness />);
    expect(screen.getAllByRole("button", { name: "特殊字符" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    expect(screen.getByRole("dialog", { name: "选择查找特殊字符" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /插入任意数字/ }));
    expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
      "图^#",
    );
    expect((screen.getByRole("textbox", { name: "替换为" }) as HTMLInputElement).value).toBe("");
    editor.destroy();
    unmount();
  });

  test("routes the shared special-character button to the last focused replacement field", async () => {
    const editor = editorWith("图1");
    function Harness() {
      const [query, setQuery] = useState("图");
      const [replacement, setReplacement] = useState("");
      return (
        <FindReplacePanel
          {...panelProps(editor, {
            mode: "replace",
            query,
            replacement,
            onQueryChange: setQuery,
            onReplacementChange: setReplacement,
          })}
        />
      );
    }

    const { unmount } = render(<Harness />);
    await userEvent.click(screen.getByRole("textbox", { name: "替换为" }));
    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    expect(screen.getByRole("dialog", { name: "选择替换特殊字符" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /插入原查找内容/ }));
    expect((screen.getByRole("textbox", { name: "替换为" }) as HTMLInputElement).value).toBe("^&");
    expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
      "图",
    );
    editor.destroy();
    unmount();
  });

  test("inserts a special code at the saved caret and replaces a saved selection", async () => {
    const editor = editorWith("技术");
    function Harness() {
      const [query, setQuery] = useState("图12");
      return <FindReplacePanel {...panelProps(editor, { query, onQueryChange: setQuery })} />;
    }

    const { unmount } = render(<Harness />);
    const query = screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement;
    query.focus();
    query.setSelectionRange(1, 3);
    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    await userEvent.click(screen.getByRole("button", { name: /插入任意数字/ }));
    expect(query.value).toBe("图^#");
    await waitFor(() => {
      expect(document.activeElement).toBe(query);
      expect(query.selectionStart).toBe(3);
      expect(query.selectionEnd).toBe(3);
    });
    editor.destroy();
    unmount();
  });

  test("chooses special search rules from a dedicated explanatory dialog", async () => {
    const editor = editorWith("图1技术");
    function Harness() {
      const [query, setQuery] = useState("图");
      return (
        <FindReplacePanel
          {...panelProps(editor, {
            query,
            onQueryChange: setQuery,
          })}
        />
      );
    }
    const { unmount } = render(<Harness />);

    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    const dialog = screen.getByRole("dialog", { name: "选择查找特殊字符" });
    expect(dialog).toBeTruthy();
    expect(screen.queryByText("匹配任意一个 Unicode 数字，例如 1、２")).toBeNull();
    expect(screen.queryByText("点击一个项目，它会自动插入到当前输入位置。")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /插入任意数字/ }));
    expect(screen.queryByRole("dialog", { name: "选择查找特殊字符" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
      "图^#",
    );
    editor.destroy();
    unmount();
  });

  test("keeps Unicode special codes intact in wildcard mode", async () => {
    const editor = editorWith("图２ 技术");
    function Harness() {
      const [query, setQuery] = useState("");
      return (
        <FindReplacePanel
          {...panelProps(editor, {
            query,
            onQueryChange: setQuery,
            options: { searchMode: "wildcard" },
          })}
        />
      );
    }
    const { unmount } = render(<Harness />);

    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    await userEvent.click(screen.getByRole("button", { name: /插入任意数字/ }));
    expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
      "^#",
    );
    await clickReady(screen.getByRole("button", { name: "下一个" }));
    expect(screen.getByText("1/1")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    await userEvent.click(screen.getByRole("button", { name: /插入任意字母/ }));
    expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
      "^#^$",
    );
    editor.destroy();
    unmount();
  });

  test("moves focus into the special-character dialog and closes it with Escape", async () => {
    const editor = editorWith("技术");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor)} />);

    const query = screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement;
    query.focus();
    query.setSelectionRange(0, 0);
    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    const firstOption = screen.getByRole("button", { name: /插入任意数字/ });
    await waitFor(() => expect(document.activeElement).toBe(firstOption));
    fireEvent.keyDown(firstOption, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "选择查找特殊字符" })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(query);
      expect(query.selectionStart).toBe(0);
      expect(query.selectionEnd).toBe(0);
    });

    editor.destroy();
    unmount();
  });

  test("resets the shared special-character target to query after leaving replace mode", async () => {
    const editor = editorWith("技术");
    const { rerender, unmount } = render(
      <FindReplacePanel {...panelProps(editor, { mode: "replace" })} />,
    );
    await userEvent.click(screen.getByRole("textbox", { name: "替换为" }));
    rerender(<FindReplacePanel {...panelProps(editor, { mode: "find" })} />);
    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    expect(screen.getByRole("dialog", { name: "选择查找特殊字符" })).toBeTruthy();
    editor.destroy();
    unmount();
  });

  test("removes the ordinary-mode special-character hint and syntax examples", () => {
    const editor = editorWith("技术");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor)} />);
    expect(screen.queryByText("点击“特殊字符”可选择任意数字、字母、汉字、换行等条件。")).toBeNull();
    expect(screen.queryByText("查看语法示例")).toBeNull();
    editor.destroy();
    unmount();
  });

  test("keeps keyboard focus inside the special-character dialog", async () => {
    const editor = editorWith("技术");
    const { unmount } = render(<FindReplacePanel {...panelProps(editor)} />);

    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    const closeButton = screen.getByRole("button", { name: "关闭选择查找特殊字符" });
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    const options = screen.getAllByRole("button", { name: /^插入/ });
    expect(document.activeElement).toBe(options.at(-1));

    editor.destroy();
    unmount();
  });

  test("shows a syntax error instead of 未找到", async () => {
    const editor = editorWith("技术");
    const { unmount } = render(
      <FindReplacePanel
        {...panelProps(editor, {
          query: "[abc",
          options: { searchMode: "wildcard" },
        })}
      />,
    );
    expect(await screen.findByText(/通配符语法有误/)).toBeTruthy();
    editor.destroy();
    unmount();
  });

  test("reports matches whose replacement would not change the document", async () => {
    const editor = editorWith("技术 技术");
    const { unmount } = render(
      <FindReplacePanel
        {...panelProps(editor, {
          mode: "replace",
          query: "技术",
          replacement: "技术",
        })}
      />,
    );

    await clickReady(screen.getByRole("button", { name: "全部替换" }));
    await userEvent.click(screen.getByRole("button", { name: "确定" }));

    expect(screen.getByText("找到 2 处，替换内容与原内容相同")).toBeTruthy();
    expect(editor.getText()).toBe("技术 技术");
    editor.destroy();
    unmount();
  });

  test("reports an unchanged single replacement instead of claiming success", async () => {
    const editor = editorWith("技术 技术");
    const matches = findLiteralMatches(editor.state.doc, "技术");
    const current = matches[0];
    if (!current) throw new Error("测试文档应包含当前匹配");
    editor.commands.setTextSelection(current);
    const { unmount } = render(
      <FindReplacePanel
        {...panelProps(editor, {
          mode: "replace",
          query: "技术",
          replacement: "技术",
        })}
      />,
    );

    await clickReady(replaceActionButton() as HTMLButtonElement);

    expect(screen.getByText("替换内容与原内容相同")).toBeTruthy();
    expect(editor.getText()).toBe("技术 技术");
    editor.destroy();
    unmount();
  });

  test("uses the complete Chinese punctuation range in regex mode", async () => {
    const editor = editorWith("《技术》");
    function Harness() {
      const [query, setQuery] = useState("");
      return (
        <FindReplacePanel
          {...panelProps(editor, {
            query,
            onQueryChange: setQuery,
            options: { searchMode: "regex" },
          })}
        />
      );
    }
    const { unmount } = render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "特殊字符" }));
    await userEvent.click(screen.getByRole("button", { name: /插入任意中文标点/ }));
    expect(await screen.findByText("0/2")).toBeTruthy();
    editor.destroy();
    unmount();
  });
});

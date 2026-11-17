import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import type { KetcherPublicApi } from "./ketcher-adapter";
import { createKetcherClipboardBridge, KetcherEditor, type KetcherRuntime } from "./ketcher-editor";

const ket = '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule"}}';

function createKetcher(): KetcherPublicApi {
  return {
    setMolecule: vi.fn().mockResolvedValue(undefined),
    getKet: vi.fn().mockResolvedValue(ket),
    generateImage: vi.fn().mockResolvedValue({ text: vi.fn().mockResolvedValue("<svg />") }),
    switchToMacromoleculesMode: vi.fn(),
    switchToMoleculesMode: vi.fn(),
    structService: { destroy: vi.fn() },
  };
}

function createRuntime(ketcher: KetcherPublicApi): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return <div data-testid="ketcher-canvas">Ketcher canvas</div>;
    },
  };
}

test("isolates SDK effects from Strict Mode replay and releases the session once", async () => {
  const ketcher = createKetcher();
  const initialized = vi.fn();
  const cleaned = vi.fn();
  const onReady = vi.fn();
  const onError = vi.fn();
  const runtime: KetcherRuntime = {
    StandaloneStructServiceProvider: class {},
    Editor: ({ onInit }) => {
      useEffect(() => {
        initialized();
        onInit?.(ketcher as never);
        return () => cleaned();
      }, [onInit]);
      return <div>Ketcher canvas</div>;
    },
  };
  const view = render(
    <StrictMode>
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(runtime)}
        onReady={onReady}
        onError={onError}
        onContentChange={vi.fn()}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(initialized).toHaveBeenCalledOnce();
  expect(cleaned).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(cleaned).toHaveBeenCalledOnce());
  expect(ketcher.structService.destroy).not.toHaveBeenCalled();
});

test("tracks empty, changed and undone structures without generating images, and unsubscribes on release", async () => {
  let currentKet = '{"root":{"nodes":[]}}';
  let changed: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const ketcher = Object.assign(createKetcher(), {
    getKet: vi.fn(async () => currentKet),
    editor: {
      subscribe: vi.fn((_name, callback) => {
        changed = callback;
        return { handler: callback };
      }),
      unsubscribe,
    },
  });
  const onContentChange = vi.fn();
  const onReady = vi.fn();
  const view = render(
    <KetcherEditor
      loadRuntime={vi.fn().mockResolvedValue(createRuntime(ketcher))}
      onReady={onReady}
      onContentChange={onContentChange}
    />,
  );
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(onContentChange).toHaveBeenLastCalledWith({ hasContent: false, dirty: false });
  currentKet = ket;
  act(() => changed?.());
  await waitFor(() =>
    expect(onContentChange).toHaveBeenLastCalledWith({ hasContent: true, dirty: true }),
  );
  currentKet = '{"root":{"nodes":[]}}';
  act(() => changed?.());
  await waitFor(() =>
    expect(onContentChange).toHaveBeenLastCalledWith({ hasContent: false, dirty: false }),
  );
  expect(ketcher.generateImage).not.toHaveBeenCalled();
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

function createRuntimeWithFileControls(ketcher: KetcherPublicApi): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div>
          <button type="button" title="Open... (Ctrl+O)">
            打开
          </button>
          <button type="button" title="Save as... (Ctrl+S)">
            保存
          </button>
          <button type="button" title="Open…">
            旧版打开
          </button>
          <button type="button" aria-label="Save as... (Ctrl+S)">
            无标题保存
          </button>
          <button type="button" title="Atoms">
            原子
          </button>
        </div>
      );
    },
  };
}

function createRuntimeWithEnglishTools(ketcher: KetcherPublicApi): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div data-testid="ketcher-canvas">
          <button type="button" title="Clear Canvas (Ctrl+Del)">
            清空
          </button>
          <button type="button" title="Single Bond (1)">
            单键
          </button>
          <button type="button" title="Benzene (T)">
            苯环
          </button>
        </div>
      );
    },
  };
}

function createRuntimeWithClipboardTools(
  ketcher: KetcherPublicApi,
  onCopyClick?: () => void,
): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div data-testid="ketcher-canvas">
          <button type="button" title="Copy (Ctrl+C)" onClick={onCopyClick}>
            复制
          </button>
          <button type="button" title="Paste (Ctrl+V)">
            粘贴
          </button>
        </div>
      );
    },
  };
}

function createRuntimeWithScrollArrows(
  ketcher: KetcherPublicApi,
  onArrowClick: () => void,
): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div>
          {/* 左侧工具栏：滚动容器带 left-toolbar-buttons testid */}
          <div data-testid="left-toolbar-buttons">
            <div>工具按钮区</div>
          </div>
          {/* 右侧工具栏：滚动容器是 root 的第一个直接子 div */}
          <div data-testid="right-toolbar">
            <div>
              <div>原子按钮区</div>
            </div>
            <button type="button" data-testid="arrow-scroll-down-button" onClick={onArrowClick}>
              ▼
            </button>
            <button type="button" data-testid="arrow-scroll-left-button" onClick={onArrowClick}>
              ▲
            </button>
          </div>
          {/* 左侧工具栏的滚动箭头（在 left-toolbar-buttons 内） */}
          <button type="button" data-testid="arrow-scroll-down-button" onClick={onArrowClick}>
            ▼
          </button>
          <button type="button" data-testid="arrow-scroll-left-button" onClick={onArrowClick}>
            ▲
          </button>
        </div>
      );
    },
  };
}

function createRuntimeWithToolbarLayout(ketcher: KetcherPublicApi): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div>
          {/* 左侧工具栏：5 组按钮 + 三角滚动区 */}
          <div data-testid="left-toolbar">
            <div data-testid="left-toolbar-buttons">
              <div>
                <button type="button" data-testid="hand">
                  手
                </button>
              </div>
              <div>
                <button type="button" data-testid="bonds">
                  键
                </button>
                <button type="button" data-testid="charge-plus">
                  正电荷
                </button>
              </div>
              <div>
                <button type="button" data-testid="sgroup">
                  S 组
                </button>
              </div>
              {/* "反应加号"及以下：应被搬入底部托盘 */}
              <div>
                <button type="button" data-testid="reaction-plus">
                  反应加号
                </button>
                <button type="button" data-testid="arrows-drop-down-button">
                  箭头
                </button>
                <button type="button" data-testid="reaction-mapping-tools-drop-down-button">
                  映射
                </button>
              </div>
              <div>
                <div>
                  <button type="button" data-testid="shapes-drop-down-button">
                    形状
                  </button>
                </div>
                <button type="button" data-testid="text">
                  文字
                </button>
                <button type="button" data-testid="images">
                  图片
                </button>
              </div>
            </div>
            <div data-testid="left-toolbar-scroll-arrows">三角按钮区</div>
          </div>
          {/* 底部工具栏：环模板与结构库 */}
          <div data-testid="bottom-toolbar">
            <div>
              <button type="button" data-testid="template-0">
                苯环
              </button>
              <button type="button" data-testid="template-1">
                环戊二烯
              </button>
              <div>
                <button type="button" data-testid="template-lib">
                  结构库
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    },
  };
}

function createRuntimeWithRightToolbarOverflow(ketcher: KetcherPublicApi): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div>
          {/* Ketcher 右侧工具栏：底部两个按钮因竖向空间不足会由 ▲▼ 翻页隐藏。 */}
          <div data-testid="right-toolbar">
            <div>
              <div>
                <button type="button" data-testid="atom-c">
                  碳
                </button>
              </div>
              <div>
                <button type="button" data-testid="any-atom">
                  任意原子
                </button>
                <div>
                  <button type="button" data-testid="extended-table">
                    扩展元素表
                  </button>
                </div>
              </div>
            </div>
            <div>
              <button type="button" data-testid="arrow-scroll-right-button">
                ▼
              </button>
              <button type="button" data-testid="arrow-scroll-left-button">
                ▲
              </button>
            </div>
          </div>
          <div data-testid="bottom-toolbar">
            <div>
              <button type="button" data-testid="template-0">
                苯环
              </button>
            </div>
          </div>
        </div>
      );
    },
  };
}

function createRuntimeWithToolbarSizing(ketcher: KetcherPublicApi): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div>
          <div data-testid="top-toolbar">
            <button type="button" data-testid="top-action">
              <svg aria-hidden="true" />
            </button>
          </div>
          <div data-testid="right-toolbar">
            <button type="button" className="Atom-module_atom__g2RUu" data-testid="atom-cl">
              <span>Cl</span>
            </button>
            <button type="button" className="Atom-module_atom__g2RUu" data-testid="atom-br">
              <span>Br</span>
            </button>
          </div>
          <div data-testid="images-drop-down-button">
            <button type="button" data-testid="images" title="Add Image">
              <svg aria-hidden="true">
                <path d="M12.19 14.476H1.524V3.81H8.38V2.286H1.524C.686 2.286 0 2.97 0 3.81v10.666C0 15.314.686 16 1.524 16H12.19c.839 0 1.524-.686 1.524-1.524V7.62H12.19v6.857zm-5.935-2.415l-1.493-1.798-2.095 2.69h8.38L8.35 9.362l-2.095 2.698zm7.46-9.775V0H12.19v2.286H9.905c.007.007 0 1.524 0 1.524h2.286v2.278c.007.007 1.523 0 1.523 0V3.81H16V2.286h-2.286z" />
              </svg>
            </button>
            <button type="button" data-testid="dropdown-expand">
              ▾
            </button>
          </div>
        </div>
      );
    },
  };
}

function createRuntimeWithPeriodicTable(ketcher: KetcherPublicApi): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div
          className="PeriodTable-module_elementsTable__Vcz12"
          data-testid="periodic-table-dialog"
        >
          <div className="PeriodTable-module_periodTable__l-Uqx" data-testid="periodic-table-grid">
            <table>
              <tbody>
                <tr>
                  <td>
                    <button
                      type="button"
                      className="ElementsTable-module_button__xCaL4"
                      data-testid="lanthanum-button"
                    >
                      La
                    </button>
                  </td>
                </tr>
                <tr>
                  <td>Ac</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      );
    },
  };
}

function createRuntimeWithEnglishPanels(ketcher: KetcherPublicApi): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit }) => {
      useEffect(() => onInit?.(ketcher as never), [onInit]);
      return (
        <div data-testid="ketcher-canvas">
          <button type="button" title="Create a monomer (Ctrl+M)">
            单体
          </button>
          <button type="button" title="Shape Ellipse">
            椭圆
          </button>
          <button type="button">▼</button>
          <p>Periodic Table</p>
          <button type="button">Single</button>
          <button type="button">List</button>
          <button type="button">Not List</button>
          <button type="button">Cancel</button>
          <button type="button">Add</button>
          <p>Structure Library</p>
          <button type="button">Aromatics (18)</button>
          <button type="button">Save to SDF</button>
          <p>Click to add to canvas</p>
          <h2>Confirm type change</h2>
          <p>Changing the type will result in a loss of inputted data. Do you wish to proceed?</p>
          <button type="button">Confirm</button>
          <button type="button">Close</button>
          <p>Unsupported S-group type found. Would you like to import structure without it?</p>
          <h2>Error Message</h2>
          <p>
            Your browser doesn't allow pasting clipboard content via button. Please use shortcut
            instead.
          </p>
          <strong>CTRL/Cmd + V</strong>
          <span>for paste</span>
          <input type="button" value="Close" />
          <div role="menu">
            <button type="button">Edit...</button>
            <button type="button">Enhanced stereochemistry...</button>
            <button type="button">Query properties</button>
            <button type="button">Highlight</button>
            <button type="button">No highlight</button>
            <button type="button">Delete</button>
            <button type="button">Query bonds</button>
            <button type="button">Change direction</button>
            <button type="button">Attach S-Group...</button>
            <button type="button">Edit S-Group...</button>
            <button type="button">Expand Abbreviation</button>
            <button type="button">Contract Abbreviation</button>
            <button type="button">Remove Abbreviation</button>
            <button type="button">Edit connection point</button>
            <button type="button">Remove assignment</button>
            <button type="button">Add new tail</button>
            <button type="button">Remove tail</button>
            <button type="button">Edit Instance</button>
            <button type="button">Expand monomer</button>
            <button type="button">Collapse monomer</button>
          </div>
        </div>
      );
    },
  };
}

function createManualRuntime(capture: {
  onInit?: (ketcher: KetcherPublicApi) => void;
  onError?: () => void;
  disableMacromoleculesEditor?: boolean | undefined;
}): KetcherRuntime {
  class StandaloneStructServiceProvider {}
  return {
    StandaloneStructServiceProvider,
    Editor: ({ onInit, errorHandler, disableMacromoleculesEditor }) => {
      capture.disableMacromoleculesEditor = disableMacromoleculesEditor;
      capture.onInit = (ketcher) => onInit?.(ketcher as never);
      capture.onError = () => errorHandler("runtime failed");
      return <div data-testid="manual-ketcher-canvas" />;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("KetcherEditor", () => {
  test.each(["bundle", "restore"])(
    "offers retry when %s stalls and ignores late completion",
    async (stage) => {
      const load = deferred<KetcherRuntime>();
      const restore = deferred<void>();
      const ketcher = createKetcher();
      vi.mocked(ketcher.setMolecule).mockReturnValue(restore.promise);
      const runtime = createRuntime(ketcher);
      const onReady = vi.fn();
      vi.useFakeTimers();
      try {
        const view = render(
          <KetcherEditor
            initialKet={ket}
            onReady={onReady}
            loadRuntime={vi
              .fn()
              .mockReturnValue(stage === "bundle" ? load.promise : Promise.resolve(runtime))}
          />,
        );
        await act(async () => {
          await Promise.resolve();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_001);
        });
        expect(screen.getByRole("button", { name: "重试" })).toBeDefined();
        await act(async () => {
          load.resolve(runtime);
          restore.resolve();
        });
        expect(onReady).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "重试" })).toBeDefined();
        view.unmount();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  test("translates property dialogs while preserving input values and chemical symbols", async () => {
    render(
      <KetcherEditor loadRuntime={vi.fn().mockResolvedValue(createRuntime(createKetcher()))} />,
    );
    const canvas = await screen.findByTestId("ketcher-canvas");
    const dialog = document.createElement("dialog");
    dialog.className = "Atom-module_atomProps__test";
    dialog.innerHTML = `<header>Atom Properties</header><label>General</label>
      <label>Isotope (atomic mass)</label><span>Diradical (singlet)</span>
      <input name="alias" value="General"><input type="button" value="Apply">
      <span class="Atom-module_atom__test">No</span><svg><text>Atom Properties</text></svg>`;
    canvas.append(dialog);
    await waitFor(() => expect(dialog.querySelector("header")?.textContent).toBe("原子属性"));
    expect(dialog.textContent).toContain("同位素（原子质量）");
    expect(dialog.textContent).toContain("双自由基（单重态）");
    expect(dialog.querySelector<HTMLInputElement>('input[name="alias"]')?.value).toBe("General");
    expect(dialog.querySelector(".Atom-module_atom__test")?.textContent).toBe("No");
    expect(dialog.querySelector("svg text")?.textContent).toBe("Atom Properties");
    const apply = dialog.querySelector<HTMLInputElement>('input[type="button"]');
    if (!apply) throw new Error("property dialog must expose an apply button");
    expect(apply.value).toBe("应用");
    apply.value = "Apply";
    apply.setAttribute("value", "Apply");
    await waitFor(() => expect(apply.value).toBe("应用"));
    const bond = document.createElement("div");
    bond.className = "Bond-module_bond__test";
    bond.innerHTML = `<span>Single</span><span>Hydrogen</span><span>Chain</span>`;
    canvas.append(bond);
    await waitFor(() => expect(bond.textContent).toBe("单键氢键链"));
  });
  test("localizes connected closed shadow roots but stops visiting detached roots", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    const label = document.createElement("button");
    label.textContent = "Cancel";
    shadow.append(label);
    const view = render(
      <KetcherEditor loadRuntime={vi.fn().mockResolvedValue(createRuntime(createKetcher()))} />,
    );
    const canvas = await screen.findByTestId("ketcher-canvas");
    canvas.append(host);
    await waitFor(() => expect(label.textContent).toBe("取消"));
    host.remove();
    label.textContent = "Cancel";
    const trigger = document.createElement("div");
    await act(async () => {
      document.body.append(trigger);
    });
    expect(label.textContent).toBe("Cancel");
    view.unmount();
    trigger.remove();
  });

  test("translates owned menus without changing document or drawing text", async () => {
    const outside = document.createElement("p");
    outside.textContent = "Gold";
    document.body.append(outside);
    const view = render(
      <KetcherEditor loadRuntime={vi.fn().mockResolvedValue(createRuntime(createKetcher()))} />,
    );
    const canvas = await screen.findByTestId("ketcher-canvas");
    const menu = document.createElement("div");
    menu.id = "owned-ketcher-menu";
    menu.innerHTML = "<button>Cancel</button>";
    const tooltip = document.createElement("div");
    tooltip.id = "owned-ketcher-tooltip";
    tooltip.textContent = "Single";
    await act(async () => {
      canvas.innerHTML =
        '<button aria-controls="owned-ketcher-menu" aria-describedby="owned-ketcher-tooltip">Single</button><button data-testid="copy-button-dropdown-triangle"></button><button data-testid="close-window-button"></button><input placeholder="Search by elements…" value="No C N"><div contenteditable="true">Carbon</div><svg><text>Gold</text></svg><textarea>Gold</textarea>';
      document.body.append(menu);
      document.body.append(tooltip);
    });
    expect(outside.textContent).toBe("Gold");
    expect(canvas.querySelector("[contenteditable]")?.textContent).toBe("Carbon");
    expect(canvas.querySelector("svg text")?.textContent).toBe("Gold");
    expect(canvas.querySelector("textarea")?.value).toBe("Gold");
    expect(menu.textContent).toBe("取消");
    expect(tooltip.textContent).toBe("单个");
    expect(canvas.querySelector("button")?.textContent).toBe("单个");
    expect(
      canvas
        .querySelector('[data-testid="copy-button-dropdown-triangle"]')
        ?.getAttribute("aria-label"),
    ).toBe("选择复制格式");
    expect(
      canvas.querySelector('[data-testid="close-window-button"]')?.getAttribute("aria-label"),
    ).toBe("关闭面板");
    expect(canvas.querySelector("input")?.placeholder).toBe("按元素搜索…");
    expect(canvas.querySelector("input")?.value).toBe("No C N");
    await act(async () => {
      const library = document.createElement("div");
      library.innerHTML =
        '<button>RNA</button><button>DNA</button><button>PEP</button><button>CHEM</button><button>Peptides</button><button>Presets (21)</button><h2>RNA Builder</h2><input placeholder="Search by name..." value="MOE(A)P"><textarea>ACGTU No</textarea>';
      canvas.append(library);
    });
    for (const code of ["RNA", "DNA", "PEP", "CHEM"])
      expect(screen.getByRole("button", { name: code }).textContent).toBe(code);
    expect(screen.getByRole("button", { name: "肽类" })).toBeDefined();
    expect(screen.getByRole("button", { name: "预设（21）" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "RNA 构建器" })).toBeDefined();
    expect(screen.getByPlaceholderText("按名称搜索…").getAttribute("value")).toBe("MOE(A)P");
    expect(screen.getByDisplayValue("ACGTU No").textContent).toBe("ACGTU No");
    await act(async () => {
      const elementButton = document.createElement("button");
      elementButton.className = "ElementsTable-module_button__test";
      elementButton.textContent = "No";
      elementButton.setAttribute("aria-label", "No");
      canvas.append(elementButton);
    });
    expect(canvas.querySelector(".ElementsTable-module_button__test")?.textContent).toBe("No");
    expect(
      canvas.querySelector(".ElementsTable-module_button__test")?.getAttribute("aria-label"),
    ).toBe("No");
    view.unmount();
    outside.remove();
    menu.remove();
    tooltip.remove();
  });

  test("preserves the ready canvas and adapter after an ordinary operation error", async () => {
    const capture: Parameters<typeof createManualRuntime>[0] = {};
    const onError = vi.fn();
    const onReady = vi.fn();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createManualRuntime(capture))}
        onError={onError}
        onReady={onReady}
      />,
    );
    await screen.findByTestId("manual-ketcher-canvas");
    const ketcher = createKetcher();
    await act(async () => capture.onInit?.(ketcher));
    const canvas = screen.getByTestId("manual-ketcher-canvas");
    await act(async () => capture.onError?.());
    expect(screen.getByTestId("manual-ketcher-canvas")).toBe(canvas);
    expect(onError).not.toHaveBeenCalled();
    expect(ketcher.structService.destroy).not.toHaveBeenCalled();
    const adapter = onReady.mock.calls[0]?.[0];
    if (!adapter) throw new Error("Expected a ready adapter");
    expect((await adapter.readDraft()).ok).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("画布已保留");
  });

  test("bridges Ketcher's rich clipboard operations to Electron's text clipboard", async () => {
    const readText = vi.fn().mockResolvedValue({ ok: true, value: "clipboard molfile" });
    const writeText = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const clipboard = createKetcherClipboardBridge({ readText, writeText });

    const [item] = await clipboard.read();
    expect(item).toBeTruthy();
    await expect(item?.getType("text/plain").then((blob) => blob.text())).resolves.toBe(
      "clipboard molfile",
    );
    await clipboard.write([
      {
        types: ["text/plain"],
        getType: vi.fn().mockResolvedValue(new Blob(["copied molfile"], { type: "text/plain" })),
      },
    ]);

    expect(readText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("copied molfile");
  });

  test("uses Ketcher's keyboard clipboard path when a toolbar button is clicked", async () => {
    const copy = vi.fn();
    const paste = vi.fn();
    document.addEventListener("copy", copy);
    document.addEventListener("paste", paste);
    try {
      const ketcher = createKetcher();
      render(
        <KetcherEditor
          loadRuntime={vi.fn().mockResolvedValue(createRuntimeWithClipboardTools(ketcher))}
        />,
      );

      await screen.findByTestId("ketcher-canvas");
      const user = userEvent.setup();
      await user.click(screen.getByText("粘贴"));

      expect(copy).not.toHaveBeenCalled();
      expect(paste).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("copy", copy);
      document.removeEventListener("paste", paste);
    }
  });

  test("does not intercept Ketcher's native copy toolbar click", async () => {
    const onCopyClick = vi.fn();
    const ketcher = createKetcher();
    render(
      <KetcherEditor
        loadRuntime={vi
          .fn()
          .mockResolvedValue(createRuntimeWithClipboardTools(ketcher, onCopyClick))}
      />,
    );

    await screen.findByTestId("ketcher-canvas");
    await userEvent.setup().click(screen.getByText("复制"));

    expect(onCopyClick).toHaveBeenCalledOnce();
  });

  test("waits for the dynamic runtime, creates a standalone provider, and restores KET", async () => {
    const ketcher = createKetcher();
    const runtime = createRuntime(ketcher);
    const loadRuntime = vi.fn().mockResolvedValue(runtime);

    render(<KetcherEditor initialKet={ket} loadRuntime={loadRuntime} />);

    expect(screen.getByText("正在加载结构编辑器…")).toBeTruthy();
    await screen.findByTestId("ketcher-canvas");
    await waitFor(() => expect(ketcher.setMolecule).toHaveBeenCalledWith(ket));
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  test("offers a retry after lazy runtime loading fails", async () => {
    const user = userEvent.setup();
    const ketcher = createKetcher();
    const loadRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk missing"))
      .mockResolvedValueOnce(createRuntime(ketcher));

    render(<KetcherEditor loadRuntime={loadRuntime} />);

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByTestId("ketcher-canvas");
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  test("hides Ketcher's actual file-control title and ARIA prefixes without hiding 2D tools", async () => {
    const ketcher = createKetcher();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createRuntimeWithFileControls(ketcher))}
      />,
    );

    await screen.findByRole("button", { name: "原子" });
    const open = screen.getByText("打开");
    const save = screen.getByText("保存");
    const legacyOpen = screen.getByText("旧版打开");
    const ariaSave = screen.getByText("无标题保存");
    const atoms = screen.getByRole("button", { name: "原子" });

    expect(getComputedStyle(open).display).toBe("none");
    expect(getComputedStyle(save).display).toBe("none");
    expect(getComputedStyle(legacyOpen).display).toBe("none");
    expect(getComputedStyle(ariaSave).display).toBe("none");
    expect(getComputedStyle(atoms).display).not.toBe("none");
  });

  test("uses Chinese tool names and gives a first-use drawing hint", async () => {
    const ketcher = createKetcher();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createRuntimeWithEnglishTools(ketcher))}
      />,
    );

    const canvas = await screen.findByTestId("ketcher-canvas");
    expect(screen.getByText("选择工具或模板，在画布中编辑结构。")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "清空画布（Ctrl+Del）" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "单键（1）" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "苯环（T）" })).toBeTruthy();

    await userEvent.setup().pointer({ target: canvas, keys: "[MouseLeft]" });
    expect(
      screen.getByText("选择工具或模板，在画布中编辑结构。").closest("[inert]"),
    ).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByText("选择工具或模板，在画布中编辑结构。")).toBeNull(),
    );
  });

  test("localizes hidden tool buttons and Ketcher's periodic-table and template-library panels", async () => {
    const ketcher = createKetcher();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createRuntimeWithEnglishPanels(ketcher))}
      />,
    );

    await screen.findByTestId("ketcher-canvas");
    expect(screen.getByRole("button", { name: "创建单体（Ctrl+M）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "椭圆形状" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开更多工具" })).toBeTruthy();
    expect(screen.getByText("元素周期表")).toBeTruthy();
    expect(screen.getByRole("button", { name: "单个" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "列表" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "非列表" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加" })).toBeTruthy();
    expect(screen.getByText("结构模板库")).toBeTruthy();
    expect(screen.getByRole("button", { name: "芳香族化合物（18）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存为 SDF" })).toBeTruthy();
    expect(screen.getByText("单击添加到画布")).toBeTruthy();
    expect(screen.getByText("确认类型更改")).toBeTruthy();
    expect(screen.getByText("更改类型将导致已输入数据丢失，是否继续？")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "关闭" })).toHaveLength(2);
    expect(
      screen.getByText("检测到不支持的 S 组类型。是否在不包含该类型的情况下导入结构？"),
    ).toBeTruthy();
    expect(screen.getByText("错误信息")).toBeTruthy();
    expect(screen.getByText("浏览器不允许通过按钮粘贴剪贴板内容，请使用快捷键。")).toBeTruthy();
    expect(screen.getByText("Ctrl+V")).toBeTruthy();
    expect(screen.getByText("进行粘贴")).toBeTruthy();
    expect(screen.getByDisplayValue("关闭")).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "增强立体化学…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查询属性" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "高亮显示" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "清除高亮" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查询键" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "更改方向" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "附加 S 组…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 S 组…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开缩写" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起缩写" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "移除缩写" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑连接点" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "移除分配" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加新尾线" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "移除尾线" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑实例" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开单体" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起单体" })).toBeTruthy();
  });

  test("keeps Ketcher's shared standalone service alive when the editor unmounts", async () => {
    const ketcher = createKetcher();
    const view = render(
      <KetcherEditor loadRuntime={vi.fn().mockResolvedValue(createRuntime(ketcher))} />,
    );

    await screen.findByTestId("ketcher-canvas");
    view.unmount();

    expect(ketcher.structService.destroy).not.toHaveBeenCalled();
  });

  test("releases the active adapter without destroying the shared service before retrying", async () => {
    const user = userEvent.setup();
    const first = createKetcher();
    vi.mocked(first.setMolecule).mockRejectedValue(new Error("restore failed"));
    const second = createKetcher();
    const capture: { onInit?: (ketcher: KetcherPublicApi) => void; onError?: () => void } = {};
    const runtime = createManualRuntime(capture);
    const loadRuntime = vi.fn().mockResolvedValue(runtime);
    render(<KetcherEditor initialKet={ket} loadRuntime={loadRuntime} />);

    await screen.findByTestId("manual-ketcher-canvas");
    act(() => capture.onInit?.(first));
    await screen.findByRole("button", { name: "重试" });
    expect(first.structService.destroy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(loadRuntime).toHaveBeenCalledTimes(2));
    await screen.findByTestId("manual-ketcher-canvas");
    act(() => capture.onInit?.(second));
    expect(first.structService.destroy).not.toHaveBeenCalled();
    expect(second.structService.destroy).not.toHaveBeenCalled();
  });

  test("ignores a repeated onInit without reloading KET or destroying the shared service", async () => {
    const ketcher = createKetcher();
    const capture: { onInit?: (value: KetcherPublicApi) => void } = {};
    const onReady = vi.fn();
    const view = render(
      <KetcherEditor
        initialKet={ket}
        loadRuntime={vi.fn().mockResolvedValue(createManualRuntime(capture))}
        onReady={onReady}
      />,
    );

    await screen.findByTestId("manual-ketcher-canvas");
    act(() => capture.onInit?.(ketcher));
    act(() => capture.onInit?.(ketcher));

    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(ketcher.setMolecule).toHaveBeenCalledOnce();
    expect(ketcher.structService.destroy).not.toHaveBeenCalled();
    view.unmount();
    expect(ketcher.structService.destroy).not.toHaveBeenCalled();
  });

  test("replaces a stale initialized instance when development Strict Mode initializes again", async () => {
    const first = createKetcher();
    const second = createKetcher();
    const capture: { onInit?: (value: KetcherPublicApi) => void } = {};
    const onReady = vi.fn();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createManualRuntime(capture))}
        onReady={onReady}
      />,
    );

    await screen.findByTestId("manual-ketcher-canvas");
    act(() => capture.onInit?.(first));
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    act(() => capture.onInit?.(second));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));

    const latestCall = onReady.mock.calls[1];
    expect(latestCall).toBeDefined();
    if (!latestCall) throw new Error("第二次初始化未返回适配器");
    const latestAdapter = latestCall[0];
    expect(await latestAdapter.readDraft()).toMatchObject({ ok: true });
    expect(first.getKet).not.toHaveBeenCalled();
    expect(second.getKet).toHaveBeenCalledOnce();
    expect(first.structService.destroy).not.toHaveBeenCalled();
  });

  test("does not wait for the macromolecules editor in a molecule session", async () => {
    const capture: { disableMacromoleculesEditor?: boolean } = {};
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createManualRuntime(capture))}
        initialMode="molecule"
      />,
    );

    await screen.findByTestId("manual-ketcher-canvas");
    expect(capture.disableMacromoleculesEditor).toBe(true);
  });

  test("keeps the macromolecules editor enabled in a macromolecule session", async () => {
    const capture: { disableMacromoleculesEditor?: boolean } = {};
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createManualRuntime(capture))}
        initialMode="macromolecule"
      />,
    );

    await screen.findByTestId("manual-ketcher-canvas");
    expect(capture.disableMacromoleculesEditor).toBe(false);
  });

  test("coalesces repeated onInit callbacks and restores KET only into the latest editor", async () => {
    const first = createKetcher();
    const second = createKetcher();
    const capture: { onInit?: (ketcher: KetcherPublicApi) => void } = {};
    const onReady = vi.fn();
    render(
      <KetcherEditor
        initialKet={ket}
        loadRuntime={vi.fn().mockResolvedValue(createManualRuntime(capture))}
        onReady={onReady}
      />,
    );

    await screen.findByTestId("manual-ketcher-canvas");
    act(() => capture.onInit?.(first));
    act(() => capture.onInit?.(second));

    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(first.setMolecule).not.toHaveBeenCalled();
    expect(second.setMolecule).toHaveBeenCalledOnce();
    expect(first.structService.destroy).not.toHaveBeenCalled();
  });

  test("does not call onReady after unmounting during async KET restoration", async () => {
    const restore = deferred<void>();
    const ketcher = createKetcher();
    ketcher.setMolecule = vi.fn().mockReturnValue(restore.promise);
    const capture: { onInit?: (value: KetcherPublicApi) => void } = {};
    const onReady = vi.fn();
    const view = render(
      <KetcherEditor
        initialKet={ket}
        loadRuntime={vi.fn().mockResolvedValue(createManualRuntime(capture))}
        onReady={onReady}
      />,
    );

    await screen.findByTestId("manual-ketcher-canvas");
    act(() => capture.onInit?.(ketcher));
    await waitFor(() => expect(ketcher.setMolecule).toHaveBeenCalledOnce());
    view.unmount();
    restore.resolve(undefined);
    await Promise.resolve();

    expect(onReady).not.toHaveBeenCalled();
    expect(ketcher.structService.destroy).not.toHaveBeenCalled();
  });

  test("does not reload its runtime when onReady triggers a parent rerender", async () => {
    const ketcher = createKetcher();
    const loadRuntime = vi.fn().mockResolvedValue(createRuntime(ketcher));
    const onReady = vi.fn();
    function Parent() {
      const [ready, setReady] = useState(false);
      return (
        <>
          <KetcherEditor
            loadRuntime={loadRuntime}
            onReady={(adapter) => {
              onReady(adapter);
              setReady(true);
            }}
            onError={() => undefined}
          />
          {ready ? <p>ready</p> : null}
        </>
      );
    }

    render(<Parent />);
    await screen.findByText("ready");
    await Promise.resolve();
    await Promise.resolve();

    expect(onReady).toHaveBeenCalledOnce();
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  test("takes over the toolbar scroll arrows: big steps on both sides, Ketcher click suppressed", async () => {
    const ketcher = createKetcher();
    const onArrowClick = vi.fn();
    render(
      <KetcherEditor
        loadRuntime={vi
          .fn()
          .mockResolvedValue(createRuntimeWithScrollArrows(ketcher, onArrowClick))}
      />,
    );

    const downButtons = await screen.findAllByTestId("arrow-scroll-down-button");
    expect(downButtons).toHaveLength(2);
    const [rightDown, leftDown] = downButtons;
    if (!rightDown || !leftDown) throw new Error("滚动按钮未完整渲染");
    const leftContainer = screen.getByTestId("left-toolbar-buttons") as HTMLElement;
    const rightContainer = rightDown.closest<HTMLElement>(
      '[data-testid="right-toolbar"]',
    )?.firstElementChild;
    expect(rightContainer).toBeTruthy();
    if (!(rightContainer instanceof HTMLElement)) throw new Error("右侧工具栏容器未渲染");

    const user = userEvent.setup();
    await user.click(leftDown);
    await waitFor(() => expect(leftContainer.scrollTop).toBeGreaterThan(0), { timeout: 2500 });
    expect(onArrowClick).not.toHaveBeenCalled();

    await user.click(rightDown);
    await waitFor(() => expect(rightContainer.scrollTop).toBeGreaterThan(0), {
      timeout: 2500,
    });
    expect(onArrowClick).not.toHaveBeenCalled();
  });

  test("keeps both toolbar scroll directions correct when animation frames use their own clock", async () => {
    const ketcher = createKetcher();
    const onArrowClick = vi.fn();
    render(
      <KetcherEditor
        loadRuntime={vi
          .fn()
          .mockResolvedValue(createRuntimeWithScrollArrows(ketcher, onArrowClick))}
      />,
    );

    const downButtons = await screen.findAllByTestId("arrow-scroll-down-button");
    const upButtons = screen.getAllByTestId("arrow-scroll-left-button");
    const [rightDown, leftDown] = downButtons;
    const [rightUp, leftUp] = upButtons;
    if (!rightDown || !leftDown || !rightUp || !leftUp) {
      throw new Error("工具栏滚动按钮未完整渲染");
    }
    const leftContainer = screen.getByTestId("left-toolbar-buttons") as HTMLElement;
    const rightContainer = rightDown.closest<HTMLElement>(
      '[data-testid="right-toolbar"]',
    )?.firstElementChild;
    if (!(rightContainer instanceof HTMLElement)) throw new Error("右侧工具栏容器未渲染");
    const animationFrames: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });

    try {
      await userEvent.setup().click(leftDown);
      const firstFrame = animationFrames.shift();
      if (!firstFrame) throw new Error("滚动动画未启动");
      act(() => firstFrame(0));
      expect(leftContainer.scrollTop).toBeGreaterThanOrEqual(0);

      const finishLeftDown = animationFrames.shift();
      if (!finishLeftDown) throw new Error("左侧展开动画未继续");
      act(() => finishLeftDown(1000));
      expect(leftContainer.scrollTop).toBe(80);

      await userEvent.setup().click(leftUp);
      const startLeftUp = animationFrames.shift();
      if (!startLeftUp) throw new Error("左侧收起动画未启动");
      act(() => startLeftUp(2000));
      const finishLeftUp = animationFrames.shift();
      if (!finishLeftUp) throw new Error("左侧收起动画未继续");
      act(() => finishLeftUp(3000));
      expect(leftContainer.scrollTop).toBe(0);

      await userEvent.setup().click(rightDown);
      const startRightDown = animationFrames.shift();
      if (!startRightDown) throw new Error("右侧展开动画未启动");
      act(() => startRightDown(4000));
      const finishRightDown = animationFrames.shift();
      if (!finishRightDown) throw new Error("右侧展开动画未继续");
      act(() => finishRightDown(5000));
      expect(rightContainer.scrollTop).toBe(80);

      await userEvent.setup().click(rightUp);
      const startRightUp = animationFrames.shift();
      if (!startRightUp) throw new Error("右侧收起动画未启动");
      act(() => startRightUp(6000));
      const finishRightUp = animationFrames.shift();
      if (!finishRightUp) throw new Error("右侧收起动画未继续");
      act(() => finishRightUp(7000));
      expect(rightContainer.scrollTop).toBe(0);
      expect(onArrowClick).not.toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
    }
  });

  test("moves the reaction-plus and lower tools to a bottom tray before the ring templates", async () => {
    const ketcher = createKetcher();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createRuntimeWithToolbarLayout(ketcher))}
      />,
    );

    const bottom = await screen.findByTestId("bottom-toolbar");
    const buttons = screen.getByTestId("left-toolbar-buttons");
    await waitFor(() =>
      expect(bottom.querySelector<HTMLElement>(".ketcher-toolbar-extras")).toBeTruthy(),
    );
    const tray = bottom.querySelector<HTMLElement>(".ketcher-toolbar-extras");
    if (!tray) throw new Error("底部扩展工具栏未渲染");

    const movedIds = [
      "reaction-plus",
      "arrows-drop-down-button",
      "reaction-mapping-tools-drop-down-button",
      "shapes-drop-down-button",
      "text",
      "images",
    ];
    // 被移动的按钮现在位于底部托盘，且排在环模板（苯环）之前
    for (const testId of movedIds) {
      expect(tray?.querySelector(`[data-testid="${testId}"]`)).toBeTruthy();
      expect(buttons.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    }
    const firstTrayButton = tray?.firstElementChild as HTMLElement | null;
    expect(firstTrayButton?.dataset.testid).toBe("reaction-plus");
    const ringTemplate = bottom.querySelector('[data-testid="template-0"]');
    if (!ringTemplate) throw new Error("环模板工具栏未渲染");
    expect(tray.compareDocumentPosition(ringTemplate) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const templateToolbar = ringTemplate.parentElement;
    expect(templateToolbar?.classList.contains("ketcher-template-toolbar")).toBe(true);
    expect(templateToolbar?.contains(screen.getByTestId("template-1"))).toBe(true);
    expect(templateToolbar?.contains(screen.getByTestId("template-lib"))).toBe(true);
    // 左侧列保留的按钮不受影响
    expect(buttons.querySelector('[data-testid="hand"]')).toBeTruthy();
    expect(buttons.querySelector('[data-testid="charge-plus"]')).toBeTruthy();
    expect(buttons.querySelector('[data-testid="sgroup"]')).toBeTruthy();
  });

  test("moves hidden right-toolbar tools into a horizontal bottom tray and hides its scroll arrows", async () => {
    const ketcher = createKetcher();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createRuntimeWithRightToolbarOverflow(ketcher))}
      />,
    );

    const bottom = await screen.findByTestId("bottom-toolbar");
    const rightToolbar = screen.getByTestId("right-toolbar");
    const tray = bottom.querySelector<HTMLElement>(".ketcher-right-toolbar-extras");
    expect(tray).toBeTruthy();
    expect(tray?.querySelector('[data-testid="any-atom"]')).toBeTruthy();
    expect(tray?.querySelector('[data-testid="extended-table"]')).toBeTruthy();
    expect(rightToolbar.querySelector('[data-testid="any-atom"]')).toBeNull();
    expect(rightToolbar.querySelector('[data-testid="extended-table"]')).toBeNull();
    expect(screen.getByTestId("arrow-scroll-right-button").hidden).toBe(true);
    expect(screen.getByTestId("arrow-scroll-left-button").hidden).toBe(true);
  });

  test("centers multi-letter atom labels and restores normal top-toolbar icon sizing", async () => {
    const ketcher = createKetcher();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createRuntimeWithToolbarSizing(ketcher))}
      />,
    );

    const topAction = await screen.findByTestId("top-action");
    const chlorine = screen.getByTestId("atom-cl");
    const bromine = screen.getByTestId("atom-br");
    const imageDropdown = screen.getByTestId("dropdown-expand");
    const imagePath = screen.getByTestId("images").querySelector("path");

    expect(topAction.style.width).toBe("32px");
    expect(topAction.style.height).toBe("32px");
    for (const atom of [chlorine, bromine]) {
      expect(atom.style.display).toBe("flex");
      expect(atom.style.justifyContent).toBe("center");
      expect(atom.style.alignItems).toBe("center");
    }
    expect(imageDropdown.hidden).toBe(true);
    expect(imagePath?.getAttribute("d")).not.toContain("l-1.493-1.798");
  });

  test("lets the periodic-table dialog grow to contain its lanthanide and actinide rows", async () => {
    const ketcher = createKetcher();
    render(
      <KetcherEditor
        loadRuntime={vi.fn().mockResolvedValue(createRuntimeWithPeriodicTable(ketcher))}
      />,
    );

    const dialog = await screen.findByTestId("periodic-table-dialog");
    const grid = screen.getByTestId("periodic-table-grid");
    const lanthanum = screen.getByTestId("lanthanum-button");
    expect(dialog.style.height).toBe("auto");
    expect(grid.style.position).toBe("relative");
    expect(lanthanum.style.display).toBe("flex");
    expect(lanthanum.style.alignItems).toBe("center");
    expect(lanthanum.style.justifyContent).toBe("center");
    expect(lanthanum.style.lineHeight).toBe("1");
  });

  test("hides file controls inserted after Ketcher mounts and disconnects its observer", async () => {
    const originalObserver = globalThis.MutationObserver;
    const disconnect = vi.fn();
    const callbacks: MutationCallback[] = [];
    let observerCount = 0;
    class TestMutationObserver {
      constructor(next: MutationCallback) {
        callbacks.push(next);
        observerCount += 1;
      }
      observe = vi.fn();
      disconnect = disconnect;
      takeRecords = vi.fn(() => []);
    }
    globalThis.MutationObserver = TestMutationObserver as never;
    try {
      const view = render(
        <KetcherEditor loadRuntime={vi.fn().mockResolvedValue(createRuntime(createKetcher()))} />,
      );
      const canvas = await screen.findByTestId("ketcher-canvas");
      const inserted = document.createElement("button");
      inserted.title = "Save as... (Ctrl+S)";
      canvas.parentElement?.append(inserted);
      for (const callback of callbacks) callback?.([], {} as MutationObserver);

      expect(inserted.hidden).toBe(true);
      view.unmount();
      // waitFor/findByTestId 内部也会创建 MutationObserver（测试框架自身），
      // 计数含框架实例；这里只验证业务 observer（隐藏文件控件 + 工具栏布局
      // 恰好 2 个）在卸载时均已断开。
      expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.MutationObserver = originalObserver;
    }
  });

  test("contains a runtime render failure and lets the user retry without losing the source", async () => {
    const ketcher = createKetcher();
    const failed = createRuntime(ketcher);
    failed.Editor = () => {
      throw new Error("runtime rendering failed");
    };
    const loadRuntime = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValue(createRuntime(ketcher));
    const onError = vi.fn();
    const onReady = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <>
          <p>Existing document remains mounted</p>
          <KetcherEditor
            initialKet={ket}
            loadRuntime={loadRuntime}
            onError={onError}
            onReady={onReady}
          />
        </>,
      );
      expect(await screen.findByText("结构编辑器未能加载。请重试。")).toBeDefined();
      expect(screen.getByText("Existing document remains mounted")).toBeDefined();
      expect(onError).toHaveBeenCalledWith({ code: "KETCHER_RUNTIME_LOAD_FAILED" });
      await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
      await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
      expect(ketcher.setMolecule).toHaveBeenCalledWith(ket);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("does not load Ketcher merely by importing the chemistry equation path", async () => {
    vi.resetModules();
    const ketcherImport = vi.fn();
    vi.doMock("ketcher-react", () => {
      ketcherImport();
      throw new Error("Ketcher must stay lazy for equation-only use");
    });
    try {
      const { normalizeChemicalEquation } = await import("../editor/chemistry-equation");

      expect(normalizeChemicalEquation("H2 + O2 -> H2O")).toMatchObject({ ok: true });
      expect(ketcherImport).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("ketcher-react");
    }
  });
});

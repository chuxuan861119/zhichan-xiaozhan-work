import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, test } from "vitest";
import {
  type PatentFunctionRailController,
  PatentFunctionRailScope,
  useOptionalPatentFunctionRail,
  usePatentFunctionRail,
} from "./function-rail-context";

function Probe({ name }: { name: string }) {
  const rail = usePatentFunctionRail();
  return (
    <div>
      <output aria-label={`${name}状态`}>
        {`${rail.userIntent}:${rail.presentation.expanded}`}
      </output>
      <button type="button" onClick={rail.pin}>
        固定{name}
      </button>
      <button type="button" onClick={rail.collapse}>
        收起{name}
      </button>
    </div>
  );
}

function CaptureController({ capture }: { capture(rail: PatentFunctionRailController): void }) {
  capture(usePatentFunctionRail());
  return null;
}

function OptionalProbe() {
  const rail = useOptionalPatentFunctionRail();
  return <output aria-label="可选状态">{rail === null ? "none" : rail.scopeKey}</output>;
}

function MissingProviderProbe() {
  usePatentFunctionRail();
  return null;
}

function Scope({ children, ...props }: { children: ReactNode; scopeKey: string }) {
  return <PatentFunctionRailScope {...props}>{children}</PatentFunctionRailScope>;
}

describe("patent function rail scope", () => {
  test("a layout remeasurement does not dismiss the rail under the pointer", () => {
    let controller!: PatentFunctionRailController;
    render(
      <PatentFunctionRailScope scopeKey="single" initialSpace="fits">
        <CaptureController capture={(value) => (controller = value)} />
      </PatentFunctionRailScope>,
    );
    act(() => controller.setHovered(true));
    act(() => controller.setSpace("constrained"));
    expect(controller.presentation).toMatchObject({
      expanded: true,
      layout: "overlay",
      reason: "hover",
    });
    act(() => controller.setHovered(false));
    expect(controller.presentation.expanded).toBe(false);
    act(() => controller.setSpace("fits"));
    expect(controller.presentation).toMatchObject({
      expanded: true,
      layout: "docked",
      reason: "auto",
    });
  });
  test("keeps pinned state when the document child changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Scope scopeKey="left">
        <Probe name="左" />
      </Scope>,
    );

    await user.click(screen.getByRole("button", { name: "固定左" }));
    rerender(
      <Scope scopeKey="left">
        <div data-document="description" />
        <Probe name="左" />
      </Scope>,
    );

    expect(screen.getByLabelText("左状态").textContent).toBe("pinned:true");
  });

  test("keeps left and right rail state independent", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Scope scopeKey="left">
          <Probe name="左" />
        </Scope>
        <Scope scopeKey="right">
          <Probe name="右" />
        </Scope>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "收起左" }));

    expect(screen.getByLabelText("左状态").textContent).toBe("collapsed:false");
    expect(screen.getByLabelText("右状态").textContent).toBe("auto:false");
  });

  test("expands a collapsed rail while a tool request is active", () => {
    let controller!: PatentFunctionRailController;
    render(
      <Scope scopeKey="left">
        <CaptureController capture={(value) => (controller = value)} />
      </Scope>,
    );

    act(() => controller.collapse());
    expect(controller.presentation.expanded).toBe(false);

    let release = () => {};
    act(() => {
      release = controller.requestTool("find-replace");
    });
    expect(controller.presentation).toMatchObject({ expanded: true, reason: "tool" });

    act(() => release());
    expect(controller.presentation).toMatchObject({ expanded: false, reason: "manual-collapse" });
  });

  test("allows a stale tool release after the provider unmounts", () => {
    let controller!: PatentFunctionRailController;
    const { unmount } = render(
      <Scope scopeKey="left">
        <CaptureController capture={(value) => (controller = value)} />
      </Scope>,
    );
    let release = () => {};
    act(() => {
      release = controller.requestTool("find-replace");
    });

    unmount();

    expect(() => release()).not.toThrow();
  });

  test("releases tool requests after StrictMode probes the provider lifecycle", () => {
    let controller!: PatentFunctionRailController;
    render(
      <StrictMode>
        <Scope scopeKey="left">
          <CaptureController capture={(value) => (controller = value)} />
        </Scope>
      </StrictMode>,
    );

    act(() => controller.collapse());
    let release = () => {};
    act(() => {
      release = controller.requestTool("find-replace");
    });
    act(() => release());

    expect(controller.presentation).toMatchObject({ expanded: false, reason: "manual-collapse" });
  });

  test("supports initial space, external tools, scope metadata, and optional access", () => {
    let fitted!: PatentFunctionRailController;
    let external!: PatentFunctionRailController;
    const { container } = render(
      <>
        <PatentFunctionRailScope scopeKey="fitted" initialSpace="fits">
          <CaptureController capture={(value) => (fitted = value)} />
        </PatentFunctionRailScope>
        <PatentFunctionRailScope scopeKey="external" externalToolIds={["find-replace"]}>
          <CaptureController capture={(value) => (external = value)} />
        </PatentFunctionRailScope>
        <OptionalProbe />
      </>,
    );

    expect(fitted.presentation).toMatchObject({ expanded: true, layout: "docked" });
    expect(external.presentation).toMatchObject({ expanded: true, reason: "tool" });
    expect(screen.getByLabelText("可选状态").textContent).toBe("none");
    const root = container.querySelector<HTMLElement>("[data-function-rail-scope='fitted']");
    expect(root?.classList.contains("patent-function-rail-scope")).toBe(true);
    expect(fitted.scopeElement).toBe(root);
  });

  test("starts expanded and pinned when the scope asks for a pinned initial intent", () => {
    let pinned!: PatentFunctionRailController;
    let plain!: PatentFunctionRailController;
    render(
      <>
        <PatentFunctionRailScope
          scopeKey="cad"
          initialSpace="constrained"
          initialUserIntent="pinned"
        >
          <CaptureController capture={(value) => (pinned = value)} />
        </PatentFunctionRailScope>
        <PatentFunctionRailScope scopeKey="plain" initialSpace="constrained">
          <CaptureController capture={(value) => (plain = value)} />
        </PatentFunctionRailScope>
      </>,
    );

    expect(pinned.userIntent).toBe("pinned");
    expect(pinned.presentation).toMatchObject({
      expanded: true,
      layout: "overlay",
      reason: "pinned",
    });
    // 不传 initialUserIntent 时仍保持原来的自动行为。
    expect(plain.userIntent).toBe("auto");
    expect(plain.presentation).toMatchObject({
      expanded: false,
      layout: "overlay",
      reason: "auto",
    });

    act(() => pinned.collapse());
    expect(pinned.presentation).toMatchObject({ expanded: false, reason: "manual-collapse" });
    act(() => pinned.releasePin());
    expect(pinned.presentation).toMatchObject({ expanded: false, reason: "auto" });
  });

  test("docks an automatic rail after single-document view gains enough space", async () => {
    let controller!: PatentFunctionRailController;
    render(
      <PatentFunctionRailScope
        scopeKey="single"
        initialSpace="constrained"
        externalToolIds={["find-replace"]}
      >
        <CaptureController capture={(value) => (controller = value)} />
      </PatentFunctionRailScope>,
    );

    expect(controller.presentation).toMatchObject({
      expanded: true,
      layout: "overlay",
      reason: "tool",
    });

    act(() => controller.setSpace("fits"));

    await waitFor(() =>
      expect(controller.presentation).toMatchObject({
        expanded: true,
        layout: "docked",
        reason: "tool",
      }),
    );
  });

  test("re-docks a manually opened rail when constrained space becomes sufficient", async () => {
    let controller!: PatentFunctionRailController;
    const { container, rerender } = render(
      <PatentFunctionRailScope scopeKey="single" initialSpace="constrained">
        <CaptureController capture={(value) => (controller = value)} />
      </PatentFunctionRailScope>,
    );

    const edgeHost = container.querySelector<HTMLElement>("[data-function-rail-edge-host]");
    expect(controller.edgeHostElement).toBe(edgeHost);
    expect(controller.presentation).toMatchObject({ expanded: false, layout: "overlay" });

    act(() => controller.collapse());
    expect(controller.presentation).toMatchObject({ expanded: false, layout: "overlay" });

    act(() => controller.pin());
    expect(controller.presentation).toMatchObject({ expanded: true, layout: "overlay" });

    act(() => controller.setSpace("fits"));
    await waitFor(() =>
      expect(controller.presentation).toMatchObject({
        expanded: true,
        layout: "docked",
        reason: "pinned",
      }),
    );

    rerender(
      <PatentFunctionRailScope scopeKey="single" initialSpace="fits">
        <div data-document="description" />
        <CaptureController capture={(value) => (controller = value)} />
      </PatentFunctionRailScope>,
    );
    expect(controller.presentation).toMatchObject({ expanded: true, layout: "docked" });

    act(() => controller.releasePin());
    expect(controller.presentation).toMatchObject({ expanded: true, layout: "docked" });
  });

  test("keeps an explicit pin across responsive changes and releases only the transient hover", () => {
    let controller!: PatentFunctionRailController;
    render(
      <PatentFunctionRailScope scopeKey="single" initialSpace="fits">
        <CaptureController capture={(value) => (controller = value)} />
      </PatentFunctionRailScope>,
    );

    act(() => {
      controller.pin();
      controller.setHovered(true);
    });
    act(() => controller.setSpace("constrained"));
    expect(controller.presentation).toMatchObject({ expanded: true, layout: "overlay" });
    expect(controller.userIntent).toBe("pinned");
    act(() => controller.releasePin());

    act(() => controller.setHovered(true));
    expect(controller.presentation.expanded).toBe(true);
    act(() => controller.setHovered(false));
    expect(controller.presentation.expanded).toBe(false);
    act(() => controller.pin());
    expect(controller.presentation).toMatchObject({ expanded: true, reason: "pinned" });
    act(() => controller.setSpace("fits"));
    expect(controller.presentation).toMatchObject({ expanded: true, layout: "docked" });
    act(() => controller.setSpace("constrained"));
    expect(controller.presentation).toMatchObject({
      expanded: true,
      layout: "overlay",
      reason: "pinned",
    });
  });

  test("a manual collapse expires when constrained space becomes sufficient", async () => {
    let controller!: PatentFunctionRailController;
    render(
      <PatentFunctionRailScope scopeKey="single" initialSpace="constrained">
        <CaptureController capture={(value) => (controller = value)} />
      </PatentFunctionRailScope>,
    );

    act(() => controller.collapse());
    expect(controller.presentation).toMatchObject({
      expanded: false,
      layout: "overlay",
      reason: "manual-collapse",
    });

    act(() => controller.setSpace("fits"));

    await waitFor(() => {
      expect(controller.userIntent).toBe("auto");
      expect(controller.presentation).toMatchObject({
        expanded: true,
        layout: "docked",
        reason: "auto",
      });
    });
    act(() => controller.collapse());
    act(() => controller.setSpace("fits"));
    expect(controller.presentation.expanded).toBe(false);
    act(() => controller.setSpace("constrained"));
    act(() => controller.setSpace("fits"));
    expect(controller.presentation).toMatchObject({ expanded: true, layout: "docked" });
  });

  test("keeps a collapsed rail open while focus or pointer remains in an owned popup", async () => {
    let controller!: PatentFunctionRailController;
    render(
      <>
        <Scope scopeKey="left">
          <CaptureController capture={(value) => (controller = value)} />
        </Scope>
        <div data-function-rail-owner="left">
          <select aria-label="外部选项">
            <option>选项一</option>
          </select>
        </div>
        <button type="button">栏外</button>
      </>,
    );
    act(() => controller.collapse());

    const select = screen.getByRole("combobox", { name: "外部选项" });
    fireEvent.pointerOver(select);
    fireEvent.focusIn(select);
    expect(controller.presentation).toMatchObject({ expanded: true, reason: "interaction" });

    fireEvent.focusOut(select);
    await waitFor(() =>
      expect(controller.presentation).toMatchObject({ expanded: true, reason: "interaction" }),
    );

    fireEvent.pointerOut(select, { relatedTarget: screen.getByRole("button", { name: "栏外" }) });
    await waitFor(() =>
      expect(controller.presentation).toMatchObject({
        expanded: false,
        reason: "manual-collapse",
      }),
    );
  });

  test("releases interaction when a focused external owner is removed without focusout", async () => {
    let controller!: PatentFunctionRailController;
    render(
      <Scope scopeKey="left">
        <CaptureController capture={(value) => (controller = value)} />
      </Scope>,
    );
    const owner = document.createElement("div");
    owner.dataset.functionRailOwner = "left";
    const input = document.createElement("input");
    input.setAttribute("aria-label", "外部输入");
    owner.append(input);
    document.body.append(owner);
    act(() => controller.collapse());

    fireEvent.focusIn(input);
    expect(controller.presentation).toMatchObject({ expanded: true, reason: "interaction" });

    owner.remove();

    await waitFor(() =>
      expect(controller.presentation).toMatchObject({
        expanded: false,
        reason: "manual-collapse",
      }),
    );
  });

  test("throws a clear error when required access is outside a provider", () => {
    expect(() => render(<MissingProviderProbe />)).toThrow(
      "usePatentFunctionRail must be used inside PatentFunctionRailScope",
    );
  });
});

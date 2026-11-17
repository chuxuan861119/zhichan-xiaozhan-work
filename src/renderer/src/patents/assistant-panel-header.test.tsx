import { readFileSync } from "node:fs";
import { fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { AiCorrectionPanel } from "./ai-correction/ai-correction-panel";
import { TextPolishPanel } from "./ai-correction/text-polish-panel";
import { PatentCheckPanel } from "./patent-check-panel";

test.each(["correction", "polish", "check"] as const)(
  "%s uses a standard close icon at the end of the header actions",
  (kind) => {
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    const noop = () => undefined;
    const { container } = render(
      kind === "correction" ? (
        <AiCorrectionPanel
          open
          status="idle"
          issues={[]}
          onClose={onClose}
          onOpenSettings={onOpenSettings}
          onStart={noop}
          onCancel={noop}
          onLocate={noop}
          onAccept={noop}
          onBatchAccept={noop}
        />
      ) : kind === "polish" ? (
        <TextPolishPanel
          open
          status="idle"
          selection={{ status: "empty" }}
          result={null}
          onClose={onClose}
          onOpenSettings={onOpenSettings}
          onStart={noop}
          onCancel={noop}
          conversationId="header-test-conversation"
          onReset={async () => undefined}
        />
      ) : (
        <PatentCheckPanel
          phase="ready"
          report={null}
          stale={false}
          onClose={onClose}
          onRun={noop}
          onRecheck={noop}
          onLocate={noop}
        />
      ),
    );
    const actions = container.querySelector(".assistant-side-panel__header-actions");
    expect(actions).not.toBeNull();
    const close = actions?.lastElementChild as HTMLButtonElement;
    expect(close.classList.contains("dialog-close-control")).toBe(true);
    expect(close.querySelector("svg.dialog-close-icon")).not.toBeNull();
    expect(close.textContent).not.toContain("×");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
    if (kind !== "check") {
      const settings = close.previousElementSibling as HTMLButtonElement;
      expect(settings.classList.contains("dialog-close-button")).toBe(false);
      expect(settings.querySelector("svg")).not.toBeNull();
      fireEvent.click(settings);
      expect(onOpenSettings).toHaveBeenCalledOnce();
    }
  },
);

test("keeps assistant header actions horizontal at the upper right without moving the title", () => {
  const css = readFileSync("src/renderer/src/app/app.css", "utf8");
  expect(css).toMatch(
    /\.assistant-side-panel__header\s*\{[^}]*align-items:\s*flex-start;[^}]*padding:\s*10px 10px 15px 20px;/su,
  );
  expect(css).toMatch(/\.assistant-side-panel__header-title\s*\{[^}]*padding-top:\s*8px;/su);
  expect(css).toMatch(
    /\.assistant-side-panel__header-actions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*4px;[^}]*flex:\s*0 0 auto;/su,
  );
});

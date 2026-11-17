import { fireEvent, render, screen } from "@testing-library/react";
import type { PasteFormattingSession } from "../paste-paragraph-formatting";
import { PasteFormattingOptions } from "./paste-formatting-options";

const session = {
  mode: "body",
  targets: [{ position: 0, source: { textAlign: "center" }, body: { textAlign: "left" } }],
  simplifications: [],
} as unknown as PasteFormattingSession;

test("places choices in the owning rail and closes with Escape from a button", () => {
  const editor = document.createElement("div");
  const layout = document.createElement("div");
  layout.className = "patent-page-with-rail";
  const rail = document.createElement("div");
  rail.className = "patent-global-function-rail__body";
  layout.append(editor, rail);
  document.body.append(layout);
  const close = vi.fn();
  const view = render(
    <PasteFormattingOptions
      session={session}
      editorElement={editor}
      onSelect={vi.fn()}
      onClose={close}
    />,
  );
  expect(rail.contains(screen.getByRole("button", { name: "使用正文段落格式" }))).toBe(true);
  fireEvent.keyDown(screen.getByRole("button", { name: "使用正文段落格式" }), { key: "Escape" });
  expect(close).toHaveBeenCalled();
  view.unmount();
  layout.remove();
});

test("identical formats do not show choices but missing content remains visible without a rail", () => {
  render(
    <PasteFormattingOptions
      session={{
        ...session,
        targets: [{ position: 0, source: {}, body: {} }],
        simplifications: ["图片未能粘贴，请补充"],
      }}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "使用正文段落格式" })).toBeNull();
  expect(screen.getByText("图片未能粘贴，请补充")).toBeDefined();
});

test("uses the matching overlay rail within its own pane and expires when the document hides", async () => {
  const scope = document.createElement("div");
  scope.dataset.functionRailScope = "left";
  const book = document.createElement("div");
  book.dataset.bookKind = "claims";
  const editor = document.createElement("div");
  book.append(editor);
  const rail = document.createElement("aside");
  rail.className = "patent-global-function-rail";
  rail.dataset.bookKind = "claims";
  rail.hidden = true;
  const host = document.createElement("div");
  host.className = "patent-global-function-rail__body";
  rail.append(host);
  scope.append(book, rail);
  document.body.append(scope);
  const close = vi.fn();
  const view = render(
    <PasteFormattingOptions
      session={session}
      editorElement={editor}
      onSelect={vi.fn()}
      onClose={close}
    />,
  );
  expect(host.querySelector('[aria-label="粘贴排版"]')).not.toBeNull();
  expect(rail.hidden).toBe(true);
  book.hidden = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(close).toHaveBeenCalled();
  view.unmount();
  scope.remove();
});

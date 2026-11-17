import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useDrawingFileDrop } from "./drawing-file-drop";

afterEach(cleanup);
test.each([
  [true, false, ["a.DWG", "b.dwg"], "import"],
  [true, false, ["a.pdf"], "existing"],
  [true, false, ["a.jpg"], "existing"],
  [false, false, ["a.dwg"], "existing"],
  [true, true, ["a.pdf"], "import"],
  [true, true, ["a.png", "b.jpg"], "import"],
  [true, false, ["a.dwg", "b.jpg"], "reject"],
  [true, true, ["a.dwg", "b.pdf"], "reject"],
  [true, true, ["a.txt"], "reject"],
] as const)(
  "routes dropped files by active workspace (%s %s %s)",
  (enabled, cadActive, names, outcome) => {
    const receive = vi.fn(),
      reject = vi.fn(),
      existing = vi.fn();
    function Fixture() {
      const drop = useDrawingFileDrop({ enabled, cadActive, onFiles: receive, onError: reject });
      return (
        <div {...drop.handlers}>
          <textarea aria-label="测试编辑器" data-testid="editor" onDrop={existing} />
          {drop.hint && <p>{drop.hint}</p>}
        </div>
      );
    }
    render(<Fixture />);
    const files = names.map((n) => new File(["synthetic"], n));
    fireEvent.drop(screen.getByTestId("editor"), { dataTransfer: { files, types: ["Files"] } });
    expect(receive).toHaveBeenCalledTimes(outcome === "import" ? 1 : 0);
    expect(reject).toHaveBeenCalledTimes(outcome === "reject" ? 1 : 0);
    expect(existing).toHaveBeenCalledTimes(outcome === "existing" ? 1 : 0);
  },
);

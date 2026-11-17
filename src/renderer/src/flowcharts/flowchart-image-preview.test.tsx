import { act, fireEvent, render, screen } from "@testing-library/react";
import { FlowchartImagePreview } from "./flowchart-image-preview";

afterEach(() => vi.unstubAllGlobals());

test("auto-fit follows viewport resize but never overrides manual zoom", () => {
  let resized = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  render(<FlowchartImagePreview src="large.png" alt="适配预览" fitOnLoad />);
  const image = screen.getByAltText("适配预览");
  Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 1200 } });
  const viewport = screen.getByTestId("flowchart-image-preview-viewport");
  let height = 648;
  Object.defineProperties(viewport, {
    clientWidth: { value: 648 },
    clientHeight: { get: () => height },
  });
  fireEvent.load(image);
  expect(screen.getByText("50%")).toBeTruthy();
  height = 348;
  act(() => resized());
  expect(screen.getByText("25%")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "放大预览" }));
  height = 248;
  act(() => resized());
  expect(screen.getByText("50%")).toBeTruthy();
});

test("fits a large replacement image on loading without losing actual-size zoom", () => {
  render(<FlowchartImagePreview src="large.png" alt="替换预览" fitOnLoad />);
  const image = screen.getByAltText("替换预览") as HTMLImageElement;
  Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 2400 } });
  Object.defineProperties(screen.getByTestId("flowchart-image-preview-viewport"), {
    clientWidth: { value: 648 },
    clientHeight: { value: 648 },
  });
  fireEvent.load(image);
  expect(screen.getByText("25%")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "实际尺寸（100%）" }));
  expect(screen.getByText("100%")).toBeTruthy();
});

test("Mac wheel gestures pan while pinch zooms, and reset clears both", () => {
  vi.stubGlobal("documentFontPlatform", "darwin");
  render(<FlowchartImagePreview src="preview.svg" alt="手势预览" />);
  const viewport = screen.getByTestId("flowchart-image-preview-viewport");
  fireEvent.wheel(viewport, { deltaX: 80, deltaY: 0 });
  fireEvent.wheel(viewport, { deltaX: 0, deltaY: 20 });
  expect(screen.getByText("100%")).toBeTruthy();
  expect(screen.getByAltText("手势预览").getAttribute("style")).toContain(
    "translate(-80px, -20px)",
  );
  fireEvent.wheel(viewport, { deltaY: -20, ctrlKey: true });
  expect(screen.queryByText("100%")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重置预览" }));
  expect(screen.getByText("100%")).toBeTruthy();
  expect(screen.getByAltText("手势预览").getAttribute("style")).toContain("translate(0px, 0px)");
});

test("Windows horizontal wheel never changes zoom", () => {
  vi.stubGlobal("documentFontPlatform", "win32");
  render(<FlowchartImagePreview src="preview.svg" alt="横向预览" />);
  fireEvent.wheel(screen.getByTestId("flowchart-image-preview-viewport"), {
    deltaX: 80,
    deltaY: 0,
  });
  expect(screen.getByText("100%")).toBeTruthy();
});

test("fits the whole image initially and supports zoom, pan and reset", () => {
  render(<FlowchartImagePreview src="preview.svg" alt="流程图预览" />);

  const image = screen.getByAltText("流程图预览");
  expect(image.classList.contains("flowchart-image-preview__image")).toBe(true);
  expect(screen.getByText("100%")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "放大预览" }));
  expect(screen.getByText("125%")).toBeTruthy();
  const viewport = screen.getByTestId("flowchart-image-preview-viewport");
  fireEvent.pointerDown(viewport, { clientX: 20, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(viewport, { clientX: 55, clientY: 45, pointerId: 1 });
  fireEvent.pointerUp(viewport, { pointerId: 1 });
  expect(image.getAttribute("style")).toContain("translate(35px, 25px)");

  fireEvent.click(screen.getByRole("button", { name: "重置预览" }));
  expect(screen.getByText("100%")).toBeTruthy();
  expect(image.getAttribute("style")).toContain("translate(0px, 0px)");
});

test("zooming below actual size preserves the panned inspection position", () => {
  render(<FlowchartImagePreview src="preview.svg" alt="平移缩放预览" />);
  const viewport = screen.getByTestId("flowchart-image-preview-viewport");
  fireEvent.pointerDown(viewport, { clientX: 20, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(viewport, { clientX: 80, clientY: 50, pointerId: 1 });
  fireEvent.pointerUp(viewport, { pointerId: 1 });
  fireEvent.click(screen.getByRole("button", { name: "缩小预览" }));
  expect(screen.getByText("75%")).toBeTruthy();
  expect(screen.getByAltText("平移缩放预览").getAttribute("style")).toContain(
    "translate(60px, 30px)",
  );
  fireEvent.click(screen.getByRole("button", { name: "实际尺寸（100%）" }));
  expect(screen.getByAltText("平移缩放预览").getAttribute("style")).toContain(
    "translate(0px, 0px)",
  );
});

test("shows loading and unavailable states inside the same bounded viewer", () => {
  const { rerender } = render(<FlowchartImagePreview src={null} alt="流程图预览" busy />);
  expect(screen.getByText("正在生成预览…")).toBeTruthy();
  rerender(<FlowchartImagePreview src={null} alt="流程图预览" message="无法生成预览" />);
  expect(screen.getByText("无法生成预览")).toBeTruthy();
});

test.each(["openharmony", "ohos"])(
  "Harmony %s scroll pans both axes and Ctrl scroll zooms",
  (platform) => {
    vi.stubGlobal("documentFontPlatform", platform);
    render(<FlowchartImagePreview src="preview.svg" alt="鸿蒙手势" />);
    const viewport = screen.getByTestId("flowchart-image-preview-viewport");
    fireEvent.wheel(viewport, { deltaX: 12, deltaY: 24 });
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByAltText("鸿蒙手势").getAttribute("style")).toContain(
      "translate(-12px, -24px)",
    );
    fireEvent.wheel(viewport, { deltaY: -20, ctrlKey: true });
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByAltText("鸿蒙手势").getAttribute("style")).toContain(
      "translate(-12px, -24px)",
    );
  },
);
test("Windows vertical wheel keeps its existing zoom behavior", () => {
  vi.stubGlobal("documentFontPlatform", "win32");
  render(<FlowchartImagePreview src="preview.svg" alt="鼠标缩放" />);
  fireEvent.wheel(screen.getByTestId("flowchart-image-preview-viewport"), { deltaY: -20 });
  expect(screen.queryByText("100%")).toBeNull();
});

test("keeps failed images recoverable and resets the view when retrying", () => {
  render(<FlowchartImagePreview src="preview.png" alt="化学结构式预览" />);
  fireEvent.click(screen.getByRole("button", { name: "放大预览" }));
  fireEvent.error(screen.getByRole("img", { name: "化学结构式预览" }));
  expect(screen.getByRole("alert").textContent).toContain("图片预览加载失败");
  expect((screen.getByRole("button", { name: "放大预览" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "重试加载预览" }));
  expect(screen.getByRole("img", { name: "化学结构式预览" }).getAttribute("src")).toBe(
    "preview.png",
  );
  expect(screen.getByText("100%")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows the inserted millimetre width at 100%, fits tall images truthfully and returns to actual size", () => {
  render(<FlowchartImagePreview src="tall.png" alt="实际尺寸预览" outputWidthMm={25.4} />);
  const image = screen.getByAltText("实际尺寸预览") as HTMLImageElement;
  const viewport = screen.getByTestId("flowchart-image-preview-viewport");
  Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 2000 } });
  Object.defineProperties(viewport, { clientWidth: { value: 240 }, clientHeight: { value: 144 } });
  fireEvent.load(image);
  expect(image.style.width).toBe("25.4mm");
  expect(screen.getByText("100%")).toBeTruthy();
  fireEvent.pointerDown(viewport, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(viewport, { clientX: 15, clientY: 20, pointerId: 1 });
  fireEvent.pointerUp(viewport, { pointerId: 1 });
  expect(image.style.transform).toContain("translate(15px, 20px)");
  fireEvent.click(screen.getByRole("button", { name: "重置预览" }));
  expect(screen.getByText("50%")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "实际尺寸（100%）" }));
  expect(screen.getByText("100%")).toBeTruthy();
  expect(image.style.transform).toContain("translate(0px, 0px)");
});

test("rotated replacement previews keep the final figure's displayed width", () => {
  render(
    <FlowchartImagePreview src="wide.png" alt="旋转预览" outputWidthMm={80} rotationDeg={90} />,
  );
  const image = screen.getByAltText("旋转预览") as HTMLImageElement;
  Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 300 } });
  fireEvent.load(image);
  expect(image.style.width).toBe("160mm");
  expect(image.style.transform).toContain("rotate(90deg)");
  expect(screen.getByText("100%")).toBeTruthy();
});

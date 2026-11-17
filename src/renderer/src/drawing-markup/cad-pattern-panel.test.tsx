import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ComponentProps, createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { type CadPatternHandle, CadPatternPanel } from "./cad-pattern-panel";
import type { CadScene } from "./cadcraft-client";

const scene: CadScene = {
  revision: 1,
  entityCount: 1,
  selection: [],
  bounds: null,
  svgFrame: { origin: [0, 0], width: 100, height: 100 },
  entities: [{ handle: "A", type: "Circle", layer: "0" }],
  primitives: [],
};
const setup = (overrides: Partial<ComponentProps<typeof CadPatternPanel>> = {}) => {
  vi.useFakeTimers();
  const props: ComponentProps<typeof CadPatternPanel> = {
    mode: "arrayrect",
    handles: ["A"],
    scene,
    point: null,
    picking: false,
    disabled: false,
    protectedHandles: [],
    query: vi.fn().mockResolvedValue(scene),
    preview: vi.fn(),
    apply: vi.fn().mockResolvedValue(undefined),
    pick: vi.fn(),
    cancel: vi.fn(),
    hint: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<CadPatternPanel {...props} />) };
};
afterEach(() => {
  cleanup();
  localStorage.removeItem("patent-workbench:cad-hatch-preferences:v1");
  vi.useRealTimers();
});

test("new hatch restores only appearance preferences, while existing hatch properties take precedence", async () => {
  localStorage.setItem("patent-workbench:cad-hatch-preferences:v1", JSON.stringify({
    pattern: "ANSI38", scale: "4.5", hatchAngle: "30", islandStyle: "outer", gapTolerance: "0.2",
    rows: "99", handles: ["OLD"], points: [[100, 100]],
  }));
  const {props, rerender} = setup({mode:"hatch",handles:[],points:[]});
  expect((screen.getByLabelText("填充比例") as HTMLInputElement).value).toBe("4.5");
  expect((screen.getByLabelText("填充角度（°）") as HTMLInputElement).value).toBe("30");
  expect((screen.getByLabelText("填充策略") as HTMLSelectElement).value).toBe("outer");
  expect((screen.getByLabelText("缺口容差") as HTMLInputElement).value).toBe("0.2");
  expect((screen.getByRole("button", {name:"应用"}) as HTMLButtonElement).disabled).toBe(true);
  const query = vi.fn().mockImplementation(async command => command === "properties"
    ? {objects:[{geometry:{pattern:"ANSI31",scale:2,angle:0,style:2}}]} : scene);
  rerender(<CadPatternPanel {...props} handles={["A"]} scene={{...scene, entities:[{handle:"A",type:"Hatch",layer:"0"}]}} query={query} />);
  await act(async()=>{});
  expect((screen.getByLabelText("填充比例") as HTMLInputElement).value).toBe("2");
  expect((screen.getByLabelText("填充策略") as HTMLSelectElement).value).toBe("ignore");
});

test("hover previews without picking, saving or enabling apply, and leave clears it", async () => {
  const ref = createRef<CadPatternHandle>();
  const { props } = setup({ ref, mode: "hatch", handles: [], points: [] });
  act(() => ref.current!.hover({ x: 4, y: 5 }));
  await act(async () => vi.advanceTimersByTime(80));
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.query).toHaveBeenCalledWith(
    "bridge.preview_modify",
    expect.objectContaining({
      command: "hatch",
      params: expect.objectContaining({ points: [[4, 5]] }),
    }),
  );
  expect(props.preview).toHaveBeenLastCalledWith(scene);
  expect(props.apply).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "应用" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => ref.current!.hover(null));
  expect(props.preview).toHaveBeenLastCalledWith(null);
});

test("parameter changes keep the last preview visible while confirmation waits for the new result", async () => {
  const { props } = setup();
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.preview).toHaveBeenLastCalledWith(scene);
  fireEvent.change(screen.getByLabelText("列数"), { target: { value: "5" } });
  expect(props.preview).toHaveBeenLastCalledWith(scene);
  expect((screen.getByRole("button", { name: "应用" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a picked point publishes confirmation without moving and does not retrace a duplicate hover", async () => {
  const ref = createRef<CadPatternHandle>();
  const pending: ((value: CadScene) => void)[] = [];
  const query = vi
    .fn()
    .mockImplementation((command: string) =>
      command === "bridge.preview_modify"
        ? new Promise<CadScene>((resolve) => pending.push(resolve))
        : Promise.resolve([]),
    );
  const point = { x: 4, y: 5 };
  const { props, rerender } = setup({ ref, mode: "hatch", handles: [], points: [], query });
  act(() => ref.current!.hover(point));
  await act(async () => vi.advanceTimersByTime(20));
  rerender(<CadPatternPanel {...props} points={[point]} point={point} />);
  await act(async () => vi.advanceTimersByTime(200));
  await act(async () => pending[0]!(scene));
  expect(pending).toHaveLength(2);
  const confirmed = { ...scene, revision: 2, acceptedPointIndices: [0] };
  await act(async () => pending[1]!(confirmed));
  expect(props.preview).toHaveBeenLastCalledWith(confirmed);
  expect(query.mock.calls.filter(([c]) => c === "bridge.preview_modify")).toHaveLength(2);
  expect((screen.getByRole("button", { name: "应用" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  expect(props.apply).toHaveBeenCalledOnce();
});

test("continuous hover publishes completed samples instead of waiting for the pointer to stop", async () => {
  const ref = createRef<CadPatternHandle>();
  let finish!: (value: CadScene) => void;
  const query = vi.fn().mockImplementation((command: string) =>
    command === "bridge.preview_modify"
      ? new Promise<CadScene>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([]),
  );
  const { props } = setup({ ref, mode: "hatch", handles: [], points: [], query });
  act(() => ref.current!.hover({ x: 2, y: 3 }));
  await act(async () => vi.advanceTimersByTime(80));
  await act(async () => vi.advanceTimersByTime(80));
  act(() => ref.current!.hover({ x: 3, y: 3 }));
  await act(async () => finish(scene));
  expect(props.preview).toHaveBeenLastCalledWith(scene);
  expect(props.apply).not.toHaveBeenCalled();
});

test("slow hover keeps only the newest waiting sample and parameters invalidate in-flight work", async () => {
  const ref = createRef<CadPatternHandle>();
  const pending: ((value: CadScene) => void)[] = [];
  const query = vi
    .fn()
    .mockImplementation((command: string) =>
      command === "bridge.preview_modify"
        ? new Promise<CadScene>((resolve) => pending.push(resolve))
        : Promise.resolve([]),
    );
  const { props } = setup({ ref, mode: "hatch", handles: [], points: [], query });
  for (let x = 1; x <= 6; x++) {
    act(() => ref.current!.hover({ x, y: 1 }));
    await act(async () => vi.advanceTimersByTime(20));
  }
  expect(query.mock.calls.filter(([command]) => command === "bridge.preview_modify")).toHaveLength(
    1,
  );
  await act(async () => pending[0]!(scene));
  expect(props.preview).toHaveBeenLastCalledWith(scene);
  expect(query).toHaveBeenLastCalledWith(
    "bridge.preview_modify",
    expect.objectContaining({
      params: expect.objectContaining({ points: [[6, 1]] }),
    }),
  );
  fireEvent.change(screen.getByLabelText("填充比例"), { target: { value: "2" } });
  const obsolete = { ...scene, revision: 99 };
  await act(async () => pending[1]!(obsolete));
  expect(props.preview).not.toHaveBeenCalledWith(obsolete);
});

test("leaving while hover calculation is running discards the late result", async () => {
  const ref = createRef<CadPatternHandle>();
  let finish!: (value: CadScene) => void;
  const query = vi.fn().mockImplementation((command: string) =>
    command === "bridge.preview_modify"
      ? new Promise<CadScene>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([]),
  );
  const { props } = setup({ ref, mode: "hatch", handles: [], points: [], query });
  act(() => ref.current!.hover({ x: 2, y: 3 }));
  await act(async () => vi.advanceTimersByTime(80));
  await act(async () => vi.advanceTimersByTime(80));
  act(() => ref.current!.hover(null));
  await act(async () => finish(scene));
  expect(props.preview).toHaveBeenLastCalledWith(null);
  expect(props.apply).not.toHaveBeenCalled();
});

test("duplicate and open picks are removed from the region list before enabling apply", async () => {
  const removePoint = vi.fn();
  const { props, rerender } = setup({
    mode: "hatch",
    handles: [],
    points: [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 100, y: 100 },
    ],
    removePoint,
    query: vi
      .fn()
      .mockResolvedValue({ ...scene, acceptedPointIndices: [0], rejectedPointIndices: [2] }),
  });
  await act(async () => vi.advanceTimersByTime(200));
  expect(removePoint.mock.calls).toEqual([[2], [1]]);
  expect(props.hint).toHaveBeenLastCalledWith(expect.stringContaining("未闭合"));
  expect((screen.getByRole("button", { name: "应用" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<CadPatternPanel {...props} points={[{ x: 1, y: 1 }]} />);
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.hint).toHaveBeenLastCalledWith(expect.stringContaining("未闭合"));
});
test("confirmation waits for current preview; parameter changes invalidate old preview", async () => {
  let resolve!: (s: CadScene) => void;
  const query = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue(scene);
  const { props } = setup({ query });
  await act(async () => vi.advanceTimersByTime(200));
  expect((screen.getByRole("button", { name: "应用" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("列数"), { target: { value: "5" } });
  await act(async () => resolve(scene));
  expect((screen.getByRole("button", { name: "应用" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(200));
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  expect(props.apply).toHaveBeenCalledWith(
    "arrayrect",
    expect.objectContaining({ cols: 5, associative: false }),
  );
});
test("unmount cancels pending preview without committing", async () => {
  let resolve!: (s: CadScene) => void;
  const { props, unmount } = setup({
    query: vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  });
  await act(async () => vi.advanceTimersByTime(200));
  unmount();
  await act(async () => resolve(scene));
  expect(props.preview).not.toHaveBeenCalledWith(scene);
  expect(props.apply).not.toHaveBeenCalled();
});

test("right-click confirmation waits for the valid preview and applies only once", async () => {
  const ref = createRef<CadPatternHandle>();
  const { props } = setup({ ref });
  act(() => {
    expect(ref.current?.apply()).toBe(true);
    expect(ref.current?.apply()).toBe(true);
  });
  expect(props.apply).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.apply).toHaveBeenCalledTimes(1);
});

test("changing a hatch point cancels queued confirmation for the old region", async () => {
  const ref = createRef<CadPatternHandle>();
  const { props, rerender } = setup({ ref, mode: "hatch", handles: [], point: { x: 1, y: 1 } });
  act(() => ref.current?.apply());
  rerender(<CadPatternPanel {...props} point={{ x: 2, y: 2 }} />);
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.apply).not.toHaveBeenCalled();
});

test("closing after right-click cancels confirmation even if geometry finishes later", async () => {
  const ref = createRef<CadPatternHandle>();
  let release!: (s: CadScene) => void;
  const { props, unmount } = setup({
    ref,
    query: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  });
  await act(async () => vi.advanceTimersByTime(200));
  act(() => ref.current?.apply());
  unmount();
  await act(async () => release(scene));
  expect(props.apply).not.toHaveBeenCalled();
});

test("failed boundary preview never commits and a new region can be confirmed", async () => {
  const ref = createRef<CadPatternHandle>();
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error("Boundary not closed"))
    .mockResolvedValue(scene);
  const { props } = setup({ ref, query });
  act(() => ref.current?.apply());
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.apply).not.toHaveBeenCalled();
  expect(props.hint).toHaveBeenCalledWith(expect.stringContaining("Boundary not closed"));
  fireEvent.change(screen.getByLabelText("列数"), { target: { value: "4" } });
  act(() => ref.current?.apply());
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.apply).toHaveBeenCalledTimes(1);
});

test("the hatch selector exposes the engine catalog rather than three hardcoded styles", async () => {
  setup({
    mode: "hatch",
    query: vi
      .fn()
      .mockImplementation(async (command) =>
        command === "hatch.patterns"
          ? { standard: ["SOLID", "ANSI31", "ANSI38", "EARTH", "NET", "AR-CONC"], user: [] }
          : scene,
      ),
  });
  await act(async () => {});
  expect(screen.queryByRole("combobox", { name: "填充图案" })).toBeNull();
  const group = screen.getByRole("group", { name: "填充图案" });
  expect(group.textContent).not.toMatch(/ANSI|SOLID|NET|AR-CONC/);
  expect(group.textContent).toContain("双交线");
  expect(group.textContent).toContain("土纹");
  expect(group.querySelectorAll("button")).toHaveLength(6);
});

test("swatches halve their texture magnification without changing the actual hatch scale", async () => {
  setup({
    mode: "hatch",
    query: vi.fn().mockImplementation(async (command) =>
      command === "hatch.patterns"
        ? { standard: ["ANSI31", "ANSI38"], user: [] }
        : command === "bridge.hatch_swatches"
          ? [
              {
                name: "ANSI38",
                solid: false,
                lines: [
                  [
                    [0, 0],
                    [64, 64],
                  ],
                ],
              },
            ]
          : scene,
    ),
  });
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("填充比例"), { target: { value: "50" } });
  const button = screen.getByRole("button", { name: "选择图案 双交线" });
  expect(button.querySelector("svg")?.getAttribute("viewBox")).toBe("8 8 48 48");
  expect(button.querySelector("svg")?.getAttribute("preserveAspectRatio")).toBe("xMidYMid slice");
  expect(button.querySelector("path")?.getAttribute("d")).toBe("M0,64 L64,0");
  expect(button.querySelector("path")?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
  fireEvent.click(button);
  expect((screen.getByLabelText("填充比例") as HTMLInputElement).value).toBe("50");
});
test("hatch displays concise values but retains the actual scale and angle", async () => {
  const query = vi
    .fn()
    .mockImplementation((cmd) =>
      Promise.resolve(
        cmd === "properties"
          ? { objects: [{ geometry: { pattern: "ANSI33", scale: 3.12345, angle: Math.PI / 7 } }] }
          : scene,
      ),
    );
  const { props } = setup({
    mode: "hatch",
    scene: { ...scene, entities: [{ handle: "A", type: "Hatch", layer: "0" }] },
    query,
  });
  await act(async () => {});
  expect((screen.getByLabelText("填充比例") as HTMLInputElement).value).toBe("3.1");
  expect((screen.getByLabelText("填充角度（°）") as HTMLInputElement).value).toBe("25.7");
  await act(async () => vi.advanceTimersByTime(200));
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  expect(props.apply).toHaveBeenCalledWith(
    "hatchedit",
    expect.objectContaining({
      pattern: "ANSI33",
      scale: 3.12345,
      angle: ((Math.PI / 7) * 180) / Math.PI,
    }),
  );
});

test("imported near-zero hatch angles display normally without changing their precision", async () => {
  const angle = 0.0028 * Math.PI / 180;
  const query = vi.fn().mockImplementation(async command => command === "properties"
    ? {objects:[{geometry:{pattern:"ANSI31",scale:1,angle,style:0}}]} : scene);
  const {props} = setup({mode:"hatch",scene:{...scene,entities:[{handle:"A",type:"Hatch",layer:"0"}]},query});
  await act(async () => {});
  expect(screen.getByLabelText("填充角度（°）")).toHaveProperty("value","0");
  await act(async () => vi.advanceTimersByTime(200));
  fireEvent.click(screen.getByRole("button",{name:"应用"}));
  expect(props.apply).toHaveBeenCalledWith("hatchedit",expect.objectContaining({angle:0.0028}));
});
test("protected objects never request a preview or allow a commit", async () => {
  const { props } = setup({ protectedHandles: ["A"] });
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.query).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "应用" }) as HTMLButtonElement).disabled).toBe(true);
});

test("hatch directly previews internal points and has no boundary picking controls", async () => {
  const { props } = setup({
    mode: "hatch",
    handles: ["A"],
    points: [{ x: 12, y: 15 }],
  });
  await act(async () => vi.advanceTimersByTime(200));
  expect(props.query).toHaveBeenCalledWith(
    "bridge.preview_modify",
    expect.objectContaining({ params: expect.objectContaining({ points: [[12, 15]] }) }),
  );
  for (const label of ["点选内部区域", "选择边界 / 已有填充", "添加边界", "添加区域", "移除边界"]) {
    expect(screen.queryByRole("button", { name: label })).toBeNull();
  }
});

test("editing a selected hatch still updates its pattern without boundary controls", async () => {
  const query = vi
    .fn()
    .mockImplementation(async (command) =>
      command === "properties"
        ? { objects: [{ geometry: { pattern: "ANSI31", scale: 2, angle: 0, style: 2 } }] }
        : command === "hatch.patterns"
          ? { standard: ["ANSI31"], user: [] }
          : scene,
    );
  const { props } = setup({
    mode: "hatch",
    scene: { ...scene, entities: [{ handle: "A", type: "Hatch", layer: "0" }] },
    query,
  });
  await act(async () => {});
  expect((screen.getByLabelText("填充策略") as HTMLSelectElement).value).toBe("ignore");
  await act(async () => vi.advanceTimersByTime(200));
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  expect(props.apply).toHaveBeenCalledWith(
    "hatchedit",
    expect.objectContaining({ handles: ["A"], style: "ignore" }),
  );
  expect(screen.queryByRole("button", { name: "添加边界" })).toBeNull();
});

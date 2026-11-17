import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadGearMeshSettings } from "./cad-gear-mesh-settings";
import type { CadScene } from "./cadcraft-client";

afterEach(cleanup);
const wheel = (
  handle: string,
  kind: "external" | "internal" | "rack" = "external",
): CadScene["entities"][number] => ({
  handle,
  type: "Block Reference",
  layer: "0",
  gear: { kind, teeth: 20, size: 80, hole: true },
});
test("unsupported combinations explain why without sending a mutation", () => {
  const apply = vi.fn(async () => {});
  render(
    <CadGearMeshSettings
      pair={[wheel("a", "rack"), wheel("b", "rack")]}
      disabled={false}
      apply={apply}
    />,
  );
  expect(screen.getByRole("checkbox", { name: "啮合" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("alert").textContent).toContain("外齿轮");
  expect(apply).not.toHaveBeenCalled();
});

test("an independent gear can join an existing train in either selection order", async () => {
  const linked = { ...wheel("a"), gearMate: "b" };
  const loose = wheel("c");
  for (const pair of [[linked,loose],[loose,linked]] as [typeof linked,typeof loose][]) {
    const apply=vi.fn(async()=>{});
    const view=render(<CadGearMeshSettings pair={pair} disabled={false} apply={apply}/>);
    const toggle=screen.getByRole("checkbox",{name:"啮合"});
    expect(toggle).toHaveProperty("disabled",false);
    expect(screen.getByText(/基准：/).textContent).toContain("外齿轮 A");
    fireEvent.click(toggle);
    await waitFor(()=>expect(apply).toHaveBeenCalledWith(true));
    view.unmount();
  }
});
test("a failed preview leaves the toggle off and permits correction without duplicate submission", async () => {
  let reject!: (error: Error) => void;
  const apply = vi.fn(
    () =>
      new Promise<void>((_resolve, r) => {
        reject = r;
      }),
  );
  render(<CadGearMeshSettings pair={[wheel("a"), wheel("b")]} disabled={false} apply={apply} />);
  const toggle = screen.getByRole("checkbox", { name: "啮合" });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(apply).toHaveBeenCalledOnce();
  expect(toggle).toHaveProperty("disabled", true);
  reject(new Error("无法调整位置"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("无法调整位置"));
  expect(toggle).toHaveProperty("checked", false);
  expect(toggle).toHaveProperty("disabled", false);
});
test("an existing relation can be switched off even if imported parameters no longer fit", () => {
  const first = { ...wheel("a", "internal"), gearMate: "b" };
  render(
    <CadGearMeshSettings
      pair={[first, { ...wheel("b"), gearMate: "a" }]}
      disabled={false}
      apply={async () => {}}
    />,
  );
  expect(screen.getByRole("checkbox", { name: "啮合" })).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: "啮合" })).toHaveProperty("disabled", false);
});

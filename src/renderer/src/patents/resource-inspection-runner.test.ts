import { createBlankPatent } from "../../../shared/patent/defaults";
import { inspectPatent } from "../../../shared/patent/validation";
import { RESOURCE_HEALTH_RULE_ID } from "../../../shared/patent-inspection/resource-health";
import { withResourceInspection } from "./resource-inspection-runner";

function fixture() {
  const patent = createBlankPatent({ patentType: "invention", name: "资源" });
  patent.figures = [
    {
      figureId: "00000000-0000-4000-8000-000000000001",
      assetId: "00000000-0000-4000-8000-000000000002",
      widthMm: 80,
    },
  ];
  return patent;
}
const base = () => ({
  inspect: vi.fn(async (patent: ReturnType<typeof fixture>, mode: "full" | "instant" = "full") =>
    inspectPatent(patent, mode),
  ),
  cancel: vi.fn(),
  dispose: vi.fn(),
});
test("full inspection merges file health at all image locations and instant mode does no file IO", async () => {
  const patent = fixture();
  const check = vi.fn(async () => ({
    patentId: patent.patentId,
    patentRevision: patent.revision,
    assets: [{ assetId: patent.figures[0]!.assetId, status: "damaged" as const }],
  }));
  const runner = withResourceInspection(base(), check);
  const report = await runner.inspect(patent);
  expect(report.issues.filter((i) => i.legacyCode === "asset-unreadable")).toHaveLength(1);
  expect(report.degradedRules.some((r) => r.ruleId === RESOURCE_HEALTH_RULE_ID)).toBe(false);
  check.mockClear();
  await runner.inspect(patent, "instant");
  expect(check).not.toHaveBeenCalled();
  runner.dispose();
});
test("failed or wrong-revision file checks retain body results and clearly remain incomplete", async () => {
  const patent = fixture();
  const runner = withResourceInspection(base(), async () => {
    throw new Error("offline file problem");
  });
  const report = await runner.inspect(patent);
  expect(report.issues.length).toBeGreaterThan(0);
  expect(report.degradedRules).toContainEqual(
    expect.objectContaining({ ruleId: RESOURCE_HEALTH_RULE_ID }),
  );
  runner.dispose();
  const stale = withResourceInspection(base(), async () => ({
    patentId: patent.patentId,
    patentRevision: 1,
    assets: [],
  }));
  expect((await stale.inspect(patent)).degradedRules).toContainEqual(
    expect.objectContaining({ ruleId: RESOURCE_HEALTH_RULE_ID }),
  );
  stale.dispose();
});
test("cancelling resource IO aborts immediately and ignores its late result", async () => {
  const patent = fixture();
  let finish!: (value: never) => void;
  let signal!: AbortSignal;
  const runner = withResourceInspection(base(), async (_p, s) => {
    signal = s;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = runner.inspect(patent);
  await vi.waitFor(() => expect(signal).toBeDefined());
  const rejected = expect(pending).rejects.toThrow();
  runner.cancel();
  await rejected;
  expect(signal.aborted).toBe(true);
  finish({ patentId: patent.patentId, patentRevision: 0, assets: [] } as never);
  runner.dispose();
});

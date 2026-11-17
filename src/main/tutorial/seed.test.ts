// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { prepareClaimsForDescription } from "../../shared/patent/claims-to-description.js";
import { CanonicalPatentSchema } from "../../shared/patent/model.js";
import { planSupplementDescriptionReferenceNumbers } from "../../shared/patent/reference-mark-operations.js";
import { TUTORIAL_LESSONS, tutorialCompleted } from "../../shared/tutorial/model.js";
import { createLibraryRuntime } from "../library/library-runtime.js";
import { createTutorialPatent, TutorialSeedService } from "./seed.js";

describe("tutorial exercises", () => {
  test("supplement exercise uses the real tool's supported chapter", () => {
    const { patent, baseline } = createTutorialPatent("supplement-number");
    const result = planSupplementDescriptionReferenceNumbers(patent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.counts.description).toBe(2);
    expect(
      tutorialCompleted(
        {
          sessionId: randomUUID(),
          lessonId: "supplement-number",
          patentId: patent.patentId,
          baseline,
        },
        result.plan.after,
      ),
    ).toBe(true);
  });
  test("all nine starting documents are valid and cannot claim completion", () => {
    for (const lesson of TUTORIAL_LESSONS) {
      const { patent, baseline } = createTutorialPatent(lesson.id);
      expect(CanonicalPatentSchema.safeParse(patent).success).toBe(true);
      expect(
        tutorialCompleted(
          { sessionId: randomUUID(), lessonId: lesson.id, patentId: patent.patentId, baseline },
          patent,
        ),
      ).toBe(false);
    }
  });
  test("format exercise preserves the original text and rejects deletion as completion", () => {
    const { patent, baseline } = createTutorialPatent("clear-format");
    const context = {
      sessionId: randomUUID(),
      lessonId: "clear-format" as const,
      patentId: patent.patentId,
      baseline,
    };
    const node = patent.books
      .find((book) => book.kind === "description")!
      .document.content.find((block) => block.id === baseline.paragraphId)!;
    if (node.type !== "paragraph") throw new Error("Expected exercise paragraph");
    node.content = [];
    expect(tutorialCompleted(context, patent)).toBe(false);
    node.content = [{ type: "text", text: "底座上设置夹持板，调节杆带动夹持板移动。", marks: [] }];
    expect(tutorialCompleted(context, patent)).toBe(true);
    expect(tutorialCompleted(context, { ...patent, patentId: randomUUID() })).toBe(false);
  });
  test.each(["invention-content", "embodiments"] as const)(
    "%s requires a real copied draft and its insertion into the matching chapter",
    (lessonId) => {
      const { patent, baseline } = createTutorialPatent(lessonId);
      const context = { sessionId: randomUUID(), lessonId, patentId: patent.patentId, baseline };
      const target =
        lessonId === "invention-content" ? "invention-content" : "detailed-embodiments";
      const draft = prepareClaimsForDescription(patent, target);
      expect(draft.ok).toBe(true);
      if (!draft.ok) return;
      const title = lessonId === "invention-content" ? "发明内容" : "具体实施方式";
      expect(tutorialCompleted(context, patent, title)).toBe(false);
      const body = patent.books.find((book) => book.kind === "description")!.document.content;
      const at = body.findIndex((block) => block.id === draft.targetNodeId);
      expect(at).toBeGreaterThanOrEqual(0);
      const template = body[at + 1]!;
      if (template.type !== "paragraph") throw new Error("Expected chapter body");
      template.content = [{ type: "text", text: draft.text, marks: [] }];
      expect(tutorialCompleted(context, patent)).toBe(false);
      expect(tutorialCompleted(context, patent, title)).toBe(true);
    },
  );
  test("real library seeding creates fresh documents, resolves assets, and keeps source baselines unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "zxw-tutorial-seed-test-"));
    const runtime = await createLibraryRuntime({
      libraryRoot: join(root, "library"),
      userDataRoot: join(root, "profile"),
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: false,
    });
    try {
      const service = new TutorialSeedService(randomUUID(), runtime);
      const first = await service.prepare("figure-sort");
      const opened = await runtime.patents.open(first.patentId);
      expect(opened.patent.figures).toHaveLength(3);
      for (const asset of opened.patent.assets)
        expect(
          (await runtime.assetStore.readAsset(asset.assetId)).original.byteLength,
        ).toBeGreaterThan(0);
      expect(tutorialCompleted(first, opened.patent)).toBe(false);
      const correct = [...opened.patent.figures].sort(
        (a, b) =>
          first.baseline.figureOrder.indexOf(a.figureId) -
          first.baseline.figureOrder.indexOf(b.figureId),
      );
      expect(tutorialCompleted(first, { ...opened.patent, figures: correct })).toBe(true);
      await runtime.patents.release(opened.sessionId);
      const second = await service.prepare("figure-sort");
      expect(second.patentId).not.toBe(first.patentId);
      const reset = await runtime.patents.open(second.patentId);
      expect(tutorialCompleted(second, reset.patent)).toBe(false);
      await runtime.patents.release(reset.sessionId);
      const cad = await service.prepare("cad-label");
      const cadOpened = await runtime.patents.open(cad.patentId);
      expect(cadOpened.patent.drawingProjects[0]?.sourceKind).toBe("image");
      expect(cadOpened.patent.drawingProjects[0]?.annotations).toEqual([]);
      expect(tutorialCompleted(cad, cadOpened.patent)).toBe(false);
      await runtime.patents.release(cadOpened.sessionId);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

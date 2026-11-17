// @vitest-environment node
import { expect, test } from "vitest";
import type { AutomationEvent } from "../../shared/automation/protocol.js";
import { AutomationBarrier, type AutomationParticipant } from "./barrier.js";

test("committed release marks views unsafe even when no adoption message was delivered", async () => {
  const events: AutomationEvent[] = [];
  const participants: AutomationParticipant[] = [
    {
      ownerId: 1,
      sessionId: "session",
      send(event) {
        events.push(event);
        if (event.type === "barrier" && event.phase === "drain")
          barrier.acknowledge(1, {
            token: event.token,
            sessionId: "session",
            phase: "drain",
            ok: true,
            dirty: false,
            revision: 0,
          });
      },
    },
  ];
  const barrier = new AutomationBarrier(() => participants, 20);
  const lock = await barrier.acquire("patent");
  lock.markCommitted();
  participants.length = 0;
  expect(await lock.adopt({ revision: 1 } as never)).toBe(false);
  lock.release();
  expect(events.at(-1)).toMatchObject({ phase: "release", committed: true });
});
test("in-flight GUI mutation and stale/foreign acknowledgements cannot enter commit", async () => {
  const barrier = new AutomationBarrier(
    () => [],
    20,
    () => false,
  );
  await expect(barrier.acquire("patent")).rejects.toMatchObject({ code: "EDITOR_DIRTY" });
  expect(() =>
    barrier.acknowledge(9, {
      token: "old",
      sessionId: "session",
      phase: "drain",
      ok: true,
      dirty: false,
      revision: 0,
    }),
  ).toThrow();
  expect(() => barrier.guardWrite("patent")).not.toThrow();
});

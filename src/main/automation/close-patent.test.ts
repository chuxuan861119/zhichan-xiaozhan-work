// @vitest-environment node
import { expect, test } from "vitest";
import type { AutomationEvent } from "../../shared/automation/protocol.js";
import type { AutomationParticipant } from "./barrier.js";
import { AutomationPatentCloser } from "./close-patent.js";

test("close only accepts the owning renderer and requires every session to have released", async () => {
  const sent: AutomationEvent[] = [];
  let participants: AutomationParticipant[] = [
    { ownerId: 1, sessionId: "one", send: (event) => sent.push(event) },
    { ownerId: 2, sessionId: "two", send: (event) => sent.push(event) },
  ];
  const closer = new AutomationPatentCloser(() => participants);
  const done = closer.close("patent", new AbortController().signal);
  const event = sent[0]!;
  if (event.type !== "close") throw new Error("fixture");
  expect(closer.isBusy("patent")).toBe(true);
  expect(() => closer.acknowledge(3, { token: event.token, sessionId: "one", ok: true })).toThrow(
    "失效",
  );
  participants = participants.filter((entry) => entry.ownerId !== 1);
  closer.acknowledge(1, { token: event.token, sessionId: "one", ok: true });
  expect(closer.pending).toBe(true);
  participants = [];
  closer.acknowledge(2, { token: event.token, sessionId: "two", ok: true });
  await done;
  expect(closer.pending).toBe(false);
});

test("timeout, unsafe editor, new session and cancellation stop close completion", async () => {
  let event: AutomationEvent | undefined;
  const closer = new AutomationPatentCloser(
    () => [
      {
        ownerId: 1,
        sessionId: "one",
        send: (value) => {
          event = value;
        },
      },
    ],
    15,
  );
  await expect(closer.close("patent", new AbortController().signal)).rejects.toMatchObject({
    code: "EDITOR_TIMEOUT",
  });
  const unsafe = closer.close("patent", new AbortController().signal);
  if (event?.type !== "close") throw new Error("fixture");
  closer.acknowledge(1, { token: event.token, sessionId: "one", ok: false });
  await expect(unsafe).rejects.toMatchObject({ code: "EDITOR_BUSY" });
  const changed = closer.close("patent", new AbortController().signal);
  if (event?.type !== "close") throw new Error("fixture");
  closer.acknowledge(1, { token: event.token, sessionId: "one", ok: true });
  await expect(changed).rejects.toMatchObject({ code: "EDITOR_CHANGED" });
  const controller = new AbortController();
  const cancelled = closer.close("patent", controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });
  expect(closer.pending).toBe(false);
});

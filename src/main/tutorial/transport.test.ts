// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createTutorialSession } from "./session.js";
import {
  markTutorialReady,
  sendTutorialCommand,
  tutorialReadyMatches,
  watchTutorialCommands,
} from "./transport.js";

test("private readiness and commands accept only the matching session and deduplicate events", async () => {
  const session = await createTutorialSession("clear-format");
  const received: string[] = [];
  const stop = watchTutorialCommands(session, (command) => received.push(command));
  try {
    await markTutorialReady(session);
    expect(
      tutorialReadyMatches(await readFile(join(session.root, "ready.json"), "utf8"), session),
    ).toBe(true);
    expect(tutorialReadyMatches("{", session)).toBe(false);
    expect(
      tutorialReadyMatches(JSON.stringify({ ready: true, sessionId: randomUUID() }), session),
    ).toBe(false);
    await writeFile(
      join(session.root, "command.json"),
      JSON.stringify({ sessionId: randomUUID(), requestId: randomUUID(), command: "close" }),
    );
    await sendTutorialCommand(session, "focus");
    await vi.waitFor(() => expect(received).toEqual(["focus"]));
    const command = await readFile(join(session.root, "command.json"), "utf8");
    await writeFile(join(session.root, "command.json"), command);
    await sendTutorialCommand(session, "close");
    await vi.waitFor(() => expect(received).toEqual(["focus", "close"]));
  } finally {
    stop();
    await rm(session.root, { recursive: true, force: true });
  }
});

import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import type { TutorialSession } from "./session.js";

const ReadySchema = z.object({ sessionId: z.string().uuid(), ready: z.literal(true) }).strict();
const CommandSchema = z
  .object({
    sessionId: z.string().uuid(),
    requestId: z.string().uuid(),
    command: z.enum(["focus", "close"]),
  })
  .strict();
export async function markTutorialReady(session: TutorialSession): Promise<void> {
  await writeFileAtomic(
    join(session.root, "ready.json"),
    JSON.stringify({ sessionId: session.sessionId, ready: true }),
    { mode: 0o600 },
  );
}
export function tutorialReadyMatches(json: string, session: TutorialSession): boolean {
  try {
    const result = ReadySchema.safeParse(JSON.parse(json));
    return result.success && result.data.sessionId === session.sessionId;
  } catch {
    return false;
  }
}
export async function sendTutorialCommand(
  session: TutorialSession,
  command: "focus" | "close",
): Promise<void> {
  await writeFileAtomic(
    join(session.root, "command.json"),
    JSON.stringify({ sessionId: session.sessionId, requestId: randomUUID(), command }),
    { mode: 0o600 },
  );
}
export function watchTutorialCommands(
  session: TutorialSession,
  onCommand: (command: "focus" | "close") => void,
): () => void {
  let disposed = false;
  let lastRequest = "";
  const receive = async () => {
    try {
      const result = CommandSchema.safeParse(
        JSON.parse(await readFile(join(session.root, "command.json"), "utf8")),
      );
      if (
        disposed ||
        !result.success ||
        result.data.sessionId !== session.sessionId ||
        result.data.requestId === lastRequest
      )
        return;
      lastRequest = result.data.requestId;
      onCommand(result.data.command);
    } catch {
      /* Atomic updates may briefly remove the previous file; never fall back to another root. */
    }
  };
  const watcher = watch(session.root, (_event, filename) => {
    if (filename?.toString() === "command.json") void receive();
  });
  watcher.on("error", () => watcher.close());
  void receive();
  return () => {
    disposed = true;
    watcher.close();
  };
}

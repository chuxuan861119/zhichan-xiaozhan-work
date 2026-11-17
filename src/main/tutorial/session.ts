import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import { type TutorialLessonId, TutorialLessonIdSchema } from "../../shared/tutorial/model.js";

const ManifestSchema = z
  .object({
    kind: z.literal("zhichan-tool-tutorial-v1"),
    sessionId: z.string().uuid(),
    lessonId: TutorialLessonIdSchema,
  })
  .strict();
export type TutorialSession = ReturnType<typeof paths>;
function paths(root: string, manifest: z.infer<typeof ManifestSchema>) {
  return {
    ...manifest,
    root,
    userData: join(root, "userData"),
    library: join(root, "library"),
    localAppData: join(root, "localAppData"),
    cliHome: join(root, "cliHome"),
  };
}
export async function createTutorialSession(lessonId: TutorialLessonId): Promise<TutorialSession> {
  TutorialLessonIdSchema.parse(lessonId);
  const root = await mkdtemp(join(realpathSync(tmpdir()), "zxw-tutorial-"));
  const manifest = ManifestSchema.parse({
    kind: "zhichan-tool-tutorial-v1",
    sessionId: randomUUID(),
    lessonId,
  });
  const session = paths(root, manifest);
  for (const directory of [
    session.userData,
    session.library,
    session.localAppData,
    session.cliHome,
  ])
    await mkdir(directory, { mode: 0o700 });
  await writeFile(join(root, "session.json"), JSON.stringify(manifest), {
    mode: 0o600,
    flag: "wx",
  });
  return session;
}
export function readTutorialSession(argv: readonly string[]): TutorialSession | null {
  const args = argv.filter((argument) => argument.startsWith("--tool-tutorial="));
  if (args.length === 0) return null;
  if (args.length !== 1) throw new Error("教学会话参数无效。");
  const root = args[0]!.slice("--tool-tutorial=".length);
  if (
    !isAbsolute(root) ||
    !basename(root).startsWith("zxw-tutorial-") ||
    dirname(root) !== realpathSync(tmpdir()) ||
    realpathSync(root) !== root ||
    lstatSync(root).isSymbolicLink()
  )
    throw new Error("教学会话目录无效。");
  const manifestPath = join(root, "session.json");
  if (lstatSync(manifestPath).isSymbolicLink() || lstatSync(manifestPath).size > 2048)
    throw new Error("教学会话清单无效。");
  const session = paths(root, ManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8"))));
  for (const directory of [
    session.userData,
    session.library,
    session.localAppData,
    session.cliHome,
  ])
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)
      throw new Error("教学会话路径被替换。");
  return session;
}

const ALLOWED = new Set<string>([
  "tutorial:read",
  "tutorial:ready",
  "tutorial:prepare",
  IPC_CHANNELS.settingsRead,
  IPC_CHANNELS.agreementsRead,
  IPC_CHANNELS.patentsList,
  IPC_CHANNELS.patentsOpen,
  IPC_CHANNELS.patentsRelease,
  IPC_CHANNELS.libraryRelease,
  IPC_CHANNELS.patentsApplyBookEdit,
  IPC_CHANNELS.patentsApplyFigureEdit,
  IPC_CHANNELS.patentsFlush,
  IPC_CHANNELS.libraryFlush,
  IPC_CHANNELS.patentsUpdateSettings,
  IPC_CHANNELS.assetsGetPreview,
  IPC_CHANNELS.assetsImportBytes,
  IPC_CHANNELS.assetsStageReferences,
  IPC_CHANNELS.assetsDiscardImports,
  IPC_CHANNELS.drawingsReadSource,
  IPC_CHANNELS.clipboardReadText,
  IPC_CHANNELS.clipboardPaste,
  IPC_CHANNELS.clipboardWriteText,
  IPC_CHANNELS.applicationGetWindowLayoutState,
  IPC_CHANNELS.applicationMaximizeWindow,
  IPC_CHANNELS.applicationDualColumnWindow,
  IPC_CHANNELS.applicationGetStartupRecoveryReport,
  IPC_CHANNELS.applicationRequestQuit,
  IPC_CHANNELS.applicationReloadRenderer,
  IPC_CHANNELS.applicationReportRendererFailure,
  IPC_CHANNELS.snapshotStatus,
  IPC_CHANNELS.snapshotCreate,
  IPC_CHANNELS.snapshotList,
]);
export function tutorialAllowsChannel(channel: string): boolean {
  return ALLOWED.has(channel);
}

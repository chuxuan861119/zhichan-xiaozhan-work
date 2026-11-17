import { createHash } from "node:crypto";
import {
  AI_CORRECTION_ISSUE_LIMIT,
  type AiCorrectionBookKind,
  type AiCorrectionEvent,
  type AiCorrectionIssue,
  AiCorrectionIssueSchema,
  type AiCorrectionPhase,
  type AiCorrectionStartRequest,
} from "../../shared/ai-correction/contract.js";
import {
  type AiCorrectionSettings,
  type AiModelProfile,
  type AiProviderId,
  activeAiModel,
} from "../../shared/ai-correction/model.js";
import { replacementSafetyReason } from "../../shared/ai-correction/replacement-policy.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import type { ProviderCorrectionResult, ProviderIssue } from "./openai-compatible-provider.js";
import {
  buildPatentCorrectionContext,
  type PatentCorrectionSegment,
} from "./patent-context-builder.js";
import type { ProviderSegment } from "./prompt.js";

type Provider = {
  correct(input: {
    providerId: AiProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    thinkingEnabled: boolean;
    signal: AbortSignal;
    scopeKind: "selection" | "current-book";
    segments: readonly ProviderSegment[];
    onPhase?(phase: AiCorrectionPhase): void;
    onReasoningDelta?(delta: string): void;
  }): Promise<ProviderCorrectionResult | ProviderIssue[]>;
};

type Vault = {
  hasApiKey(profileId: string): Promise<boolean>;
  withApiKey<T>(profileId: string, use: (apiKey: string) => Promise<T>): Promise<T>;
};

const MAX_CHUNK_CHARACTERS = 50_000;
const CHUNK_CONTEXT_CHARACTERS = 128;
const MAX_ANCHOR_REPAIR_DISTANCE = 32;
const THINKING_CHUNK_TIMEOUT_MS = 600_000;

function resolveProviderIssueRange(
  text: string,
  issue: Pick<ProviderIssue, "startOffset" | "endOffset" | "originalText">,
): { startOffset: number; endOffset: number } | null {
  if (
    issue.endOffset <= text.length &&
    text.slice(issue.startOffset, issue.endOffset) === issue.originalText
  ) {
    return { startOffset: issue.startOffset, endOffset: issue.endOffset };
  }
  const minimumStart = Math.max(0, issue.startOffset - MAX_ANCHOR_REPAIR_DISTANCE);
  const maximumStart = Math.min(
    text.length - issue.originalText.length,
    issue.startOffset + MAX_ANCHOR_REPAIR_DISTANCE,
  );
  if (maximumStart < minimumStart) return null;
  const matches: number[] = [];
  let candidate = text.indexOf(issue.originalText, minimumStart);
  while (candidate >= minimumStart && candidate <= maximumStart) {
    matches.push(candidate);
    if (matches.length > 1) return null;
    candidate = text.indexOf(issue.originalText, candidate + 1);
  }
  const startOffset = matches[0];
  return startOffset === undefined
    ? null
    : { startOffset, endOffset: startOffset + issue.originalText.length };
}

function chunkSegments(segments: readonly PatentCorrectionSegment[]): PatentCorrectionSegment[][] {
  const chunks: PatentCorrectionSegment[][] = [];
  let current: PatentCorrectionSegment[] = [];
  let currentCharacters = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    currentCharacters = 0;
  };

  for (const segment of segments) {
    const objectCharacters = segment.objects?.reduce((n, o) => n + o.description.length, 0) ?? 0;
    if (objectCharacters >= MAX_CHUNK_CHARACTERS)
      throw new Error("单个片段的公式内容超过处理容量，请缩小范围后检查。");
    if (segment.text.length + objectCharacters <= MAX_CHUNK_CHARACTERS) {
      if (currentCharacters + segment.text.length + objectCharacters > MAX_CHUNK_CHARACTERS)
        flush();
      current.push(segment);
      currentCharacters += segment.text.length + objectCharacters;
      continue;
    }

    flush();
    for (let offset = 0, part = 1; offset < segment.text.length; part += 1) {
      const capacity = MAX_CHUNK_CHARACTERS - objectCharacters;
      let start = Math.max(
        0,
        offset - Math.min(CHUNK_CONTEXT_CHARACTERS, Math.max(0, capacity - 2)),
      );
      if (start > 0 && /[\uDC00-\uDFFF]/u.test(segment.text.charAt(start))) start++;
      let end = Math.min(segment.text.length, start + capacity);
      if (end < segment.text.length) {
        const candidate = segment.text.slice(offset, end);
        const boundary = Math.max(
          candidate.lastIndexOf("。"),
          candidate.lastIndexOf("；"),
          candidate.lastIndexOf("\n"),
        );
        if (boundary >= MAX_CHUNK_CHARACTERS / 2) end = offset + boundary + 1;
        else if (/[\uD800-\uDBFF]/u.test(segment.text.charAt(end - 1))) end--;
      }
      if (end <= offset) throw new Error("单个片段的公式内容超过处理容量，请缩小范围后检查。");
      const text = segment.text.slice(start, end);
      chunks.push([
        {
          ...segment,
          segmentId: `${segment.segmentId}-part-${part}`,
          sourceStartOffset: segment.sourceStartOffset + start,
          text,
          checkFromOffset: offset - start,
          objects: segment.objects
            ?.filter((o) => o.offset >= start && o.offset < end)
            .map((o) => ({ ...o, offset: o.offset - start })),
          boundary: {
            startsAtParagraphStart:
              start === 0 && segment.boundary?.startsAtParagraphStart === true,
            endsAtParagraphEnd:
              end === segment.text.length && segment.boundary?.endsAtParagraphEnd === true,
          },
        },
      ]);
      offset = end;
    }
  }
  flush();
  return chunks;
}

function completeClaimGroupIds(
  allSegments: readonly PatentCorrectionSegment[],
  chunk: readonly PatentCorrectionSegment[],
): Set<string> {
  const allGroups = new Map<string, PatentCorrectionSegment[]>();
  for (const segment of allSegments) {
    const groupId = segment.claim?.groupId;
    if (!groupId) continue;
    const group = allGroups.get(groupId) ?? [];
    group.push(segment);
    allGroups.set(groupId, group);
  }
  const chunkIds = new Set(chunk.map((segment) => segment.segmentId));
  return new Set(
    [...allGroups.entries()]
      .filter(
        ([, segments]) =>
          segments.length > 0 &&
          new Set(segments.map((segment) => segment.claim?.paragraphIndex)).size ===
            segments[0]?.claim?.paragraphCount &&
          segments.every(
            (segment) =>
              chunkIds.has(segment.segmentId) &&
              segment.boundary?.startsAtParagraphStart === true &&
              segment.boundary.endsAtParagraphEnd === true,
          ),
      )
      .map(([groupId]) => groupId),
  );
}

function markOverlappingReplacements(issues: readonly AiCorrectionIssue[]): AiCorrectionIssue[] {
  const replacements = issues
    .filter((issue) => issue.applicability === "replace")
    .sort(
      (a, b) =>
        a.anchor.blockId.localeCompare(b.anchor.blockId) ||
        a.anchor.startOffset - b.anchor.startOffset,
    );
  const conflicting = new Set<AiCorrectionIssue>();
  for (const [index, issue] of replacements.entries()) {
    for (let next = index + 1; next < replacements.length; next++) {
      const other = replacements[next];
      if (
        !other ||
        other.anchor.blockId !== issue.anchor.blockId ||
        other.anchor.startOffset >= issue.anchor.endOffset
      )
        break;
      conflicting.add(issue);
      conflicting.add(other);
    }
  }
  return issues.map((issue) =>
    conflicting.has(issue)
      ? {
          ...issue,
          risk: "high" as const,
          applicability: "analysis-only" as const,
          replacement: null,
          explanation: `${issue.explanation.slice(0, 900)} 此建议与其他建议的替换范围重叠，请人工核对。`,
        }
      : issue,
  );
}

export class PatentCorrectionServiceError extends Error {
  constructor(
    readonly code:
      | "AI_DISABLED"
      | "AI_CREDENTIAL_UNAVAILABLE"
      | "REVISION_CONFLICT"
      | "BUSY"
      | "CONVERSATION_EXISTS"
      | "CONTEXT_CAPACITY_EXCEEDED"
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "MODEL_CHANGED"
      | "AI_PROVIDER_UNAVAILABLE"
      | "SUMMARY_FAILED"
      | "HISTORY_SAVE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PatentCorrectionServiceError";
  }
}

export class PatentCorrectionService {
  readonly #jobs = new Map<
    string,
    {
      sessionId: string;
      bookKind: AiCorrectionBookKind;
      controller: AbortController;
    }
  >();

  constructor(
    private readonly dependencies: {
      readSettings(): Promise<AiCorrectionSettings>;
      vault: Vault;
      patents: { requireActiveReadSession(sessionId: string, patentId: string): CanonicalPatent };
      provider: Provider;
      emit(event: AiCorrectionEvent): void;
      randomUUID(): string;
    },
  ) {}

  async start(
    request: AiCorrectionStartRequest,
    ensureConnection?: () => Promise<void>,
  ): Promise<{ jobId: string }> {
    const requestedBookKind = request.scope.bookKind;
    if (
      this.#jobs.has(request.jobId) ||
      [...this.#jobs.values()].some(
        (job) => job.sessionId === request.sessionId && job.bookKind === requestedBookKind,
      )
    )
      throw new PatentCorrectionServiceError("BUSY", "当前文档已有 AI 纠错任务运行中。");
    const jobId = request.jobId;
    const controller = new AbortController();
    this.#jobs.set(jobId, {
      sessionId: request.sessionId,
      bookKind: requestedBookKind,
      controller,
    });
    try {
      if (ensureConnection) await ensureConnection();
      controller.signal.throwIfAborted();
      return await this.#prepare(request, controller);
    } catch (error) {
      this.#jobs.delete(jobId);
      if (controller.signal.aborted) {
        this.dependencies.emit({ type: "cancelled", jobId });
        return { jobId };
      }
      throw error;
    }
  }

  async #prepare(
    request: AiCorrectionStartRequest,
    controller: AbortController,
  ): Promise<{ jobId: string }> {
    const settings = await this.dependencies.readSettings();
    controller.signal.throwIfAborted();
    const profile = activeAiModel(settings);
    if (!profile) {
      throw new PatentCorrectionServiceError("AI_DISABLED", "请先选择用于 AI 纠错的模型。");
    }
    const hasCredential =
      profile.providerId === "ollama" ||
      (await this.dependencies.vault.hasApiKey(profile.profileId));
    controller.signal.throwIfAborted();
    if (!hasCredential) {
      throw new PatentCorrectionServiceError("AI_CREDENTIAL_UNAVAILABLE", "请先配置 API Key。");
    }
    const patent = this.dependencies.patents.requireActiveReadSession(
      request.sessionId,
      request.patentId,
    );
    if (patent.revision !== request.expectedRevision) {
      throw new PatentCorrectionServiceError(
        "REVISION_CONFLICT",
        "专利内容已变化，请重新发起检查。",
      );
    }
    const context = buildPatentCorrectionContext(
      patent,
      request.scope,
      settings.maxUploadCharacters,
    );
    const jobId = request.jobId;
    this.dependencies.emit({ type: "started", jobId });
    void this.#run({ request, settings, profile, context, jobId, controller });
    return { jobId };
  }

  cancel(jobId: string): boolean {
    const job = this.#jobs.get(jobId);
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  async #run(input: {
    request: AiCorrectionStartRequest;
    settings: AiCorrectionSettings;
    profile: AiModelProfile;
    context: ReturnType<typeof buildPatentCorrectionContext>;
    jobId: string;
    controller: AbortController;
  }): Promise<void> {
    try {
      this.dependencies.emit({ type: "phase", jobId: input.jobId, phase: "preparing" });
      const chunks = chunkSegments(input.context.segments);
      this.dependencies.emit({
        type: "progress",
        jobId: input.jobId,
        completedChunks: 0,
        totalChunks: chunks.length,
      });
      const thinkingEnabled = true;
      const timeoutMs = THINKING_CHUNK_TIMEOUT_MS;
      const correct = async (apiKey: string) => {
        let allIssues: AiCorrectionIssue[] = [];
        let resultLimitReached = false;
        let discardedIssueCount = 0;
        for (const [index, chunk] of chunks.entries()) {
          if (input.controller.signal.aborted) break;
          const completeGroups = completeClaimGroupIds(input.context.segments, chunk);
          let lastPhase: AiCorrectionPhase | null = null;
          const emitPhase = (phase: AiCorrectionPhase) => {
            if (lastPhase === phase) return;
            lastPhase = phase;
            this.dependencies.emit({ type: "phase", jobId: input.jobId, phase });
          };
          emitPhase("connecting");
          const providerOutput = await this.dependencies.provider.correct({
            providerId: input.profile.providerId,
            baseUrl: input.profile.baseUrl,
            model: input.profile.model,
            apiKey,
            timeoutMs,
            thinkingEnabled,
            signal: input.controller.signal,
            scopeKind: input.request.scope.kind,
            segments: chunk.map(
              ({
                segmentId,
                bookKind,
                text,
                checkFromOffset,
                boundary,
                structure,
                claim,
                objects,
                tableStructure,
              }) => ({
                segmentId,
                bookKind,
                text,
                ...(checkFromOffset === undefined ? {} : { checkFromOffset }),
                boundary,
                structure,
                objects,
                tableStructure,
                claim: claim
                  ? {
                      ...claim,
                      complete:
                        claim.groupId !== undefined
                          ? completeGroups.has(claim.groupId)
                          : input.context.documentComplete && chunks.length === 1,
                    }
                  : claim,
                requestContext: {
                  chunkIndex: index + 1,
                  chunkCount: chunks.length,
                  completeDocument: input.context.documentComplete && chunks.length === 1,
                },
              }),
            ),
            onPhase: emitPhase,
            onReasoningDelta: (delta) =>
              this.dependencies.emit({
                type: "reasoning",
                jobId: input.jobId,
                delta,
              }),
          });
          if (input.controller.signal.aborted) break;
          emitPhase("structuring");
          const result = Array.isArray(providerOutput)
            ? {
                issues: providerOutput,
                rejectedIssueCount: 0,
                resultLimitReached: providerOutput.length === AI_CORRECTION_ISSUE_LIMIT,
              }
            : providerOutput;
          const anchored = this.#anchorIssues(result.issues, chunk, input.context.sourceTexts);
          allIssues = markOverlappingReplacements([...allIssues, ...anchored.issues]);
          discardedIssueCount += result.rejectedIssueCount + anchored.discardedIssueCount;
          if (result.resultLimitReached) resultLimitReached = true;
          if (chunks.length > 1)
            this.dependencies.emit({
              type: "partial",
              jobId: input.jobId,
              issues: [...allIssues],
              completedChunks: index + 1,
              totalChunks: chunks.length,
              resultLimitReached,
              discardedIssueCount,
            });
          this.dependencies.emit({
            type: "progress",
            jobId: input.jobId,
            completedChunks: index + 1,
            totalChunks: chunks.length,
          });
        }
        return { providerIssues: allIssues, resultLimitReached, discardedIssueCount };
      };
      const { providerIssues, resultLimitReached, discardedIssueCount } =
        input.profile.providerId === "ollama"
          ? await correct("ollama")
          : await this.dependencies.vault.withApiKey(input.profile.profileId, correct);
      if (input.controller.signal.aborted) {
        this.dependencies.emit({ type: "cancelled", jobId: input.jobId });
        return;
      }
      this.dependencies.emit({
        type: "completed",
        jobId: input.jobId,
        issues: providerIssues,
        resultLimitReached,
        discardedIssueCount,
      });
    } catch (error) {
      if (input.controller.signal.aborted) {
        this.dependencies.emit({ type: "cancelled", jobId: input.jobId });
      } else {
        this.dependencies.emit({
          type: "failed",
          jobId: input.jobId,
          message: error instanceof Error ? error.message.slice(0, 500) : "AI 纠错失败。",
        });
      }
    } finally {
      const current = this.#jobs.get(input.jobId);
      if (current?.controller === input.controller) this.#jobs.delete(input.jobId);
    }
  }

  #anchorIssues(
    issues: readonly ProviderIssue[],
    segments: readonly PatentCorrectionSegment[],
    sourceTexts: Record<string, string>,
  ): { issues: AiCorrectionIssue[]; discardedIssueCount: number } {
    const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
    const unique = new Map<string, AiCorrectionIssue>();
    let discardedIssueCount = 0;
    for (const issue of issues) {
      if (issue.applicability === "replace" && issue.originalText === issue.replacement) {
        discardedIssueCount += 1;
        continue;
      }
      const segment = byId.get(issue.segmentId);
      if (!segment) {
        discardedIssueCount += 1;
        continue;
      }
      const range = resolveProviderIssueRange(segment.text, issue);
      if (!range) {
        discardedIssueCount += 1;
        continue;
      }
      // The prefix was checked in the previous batch; do not duplicate its findings.
      if (range.endOffset <= (segment.checkFromOffset ?? 0)) continue;
      const originalText = issue.originalText;
      const sourceText = sourceTexts[segment.blockId] ?? segment.text;
      const start = segment.sourceStartOffset + range.startOffset;
      const end = segment.sourceStartOffset + range.endOffset;
      const containsObject =
        originalText.includes("\uFFFC") || issue.replacement?.includes("\uFFFC");
      const safetyReason = containsObject
        ? "此处包含公式或行内对象，请人工核对，不可直接替换。"
        : issue.applicability === "replace" && issue.replacement !== null
          ? replacementSafetyReason(originalText, issue.replacement)
          : null;
      const anchored = AiCorrectionIssueSchema.safeParse({
        issueId: this.dependencies.randomUUID(),
        category: issue.category,
        risk: safetyReason ? "high" : issue.risk,
        applicability: safetyReason ? "analysis-only" : issue.applicability,
        replacement: safetyReason ? null : issue.replacement,
        explanation: safetyReason
          ? `${issue.explanation.slice(0, 900)} ${safetyReason}`
          : issue.explanation,
        anchor: {
          bookKind: segment.bookKind,
          blockId: segment.blockId,
          startOffset: segment.sourceStartOffset + range.startOffset,
          endOffset: segment.sourceStartOffset + range.endOffset,
          originalText,
          originalTextHash: createHash("sha256").update(originalText).digest("hex"),
          contextBefore: sourceText.slice(Math.max(0, start - 32), start),
          contextAfter: sourceText.slice(end, end + 32),
        },
      });
      if (!anchored.success) {
        discardedIssueCount += 1;
        continue;
      }
      const value = anchored.data;
      const key = `${value.anchor.bookKind}:${value.anchor.blockId}:${value.anchor.startOffset}:${value.anchor.endOffset}:${value.category}:${value.replacement ?? ""}`;
      if (!unique.has(key)) unique.set(key, value);
    }
    return { issues: [...unique.values()], discardedIssueCount };
  }
}

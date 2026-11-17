import { useCallback, useEffect, useRef, useState } from "react";
import type { CanonicalPatent } from "../../../shared/patent/model";
import {
  type InspectionMode,
  PATENT_INSPECTION_ENGINE_VERSION,
  type PatentInspectionReport,
} from "../../../shared/patent-inspection/types";

type PatentInspector = (
  patent: CanonicalPatent,
  mode?: InspectionMode,
) => PatentInspectionReport | Promise<PatentInspectionReport>;

type UsePatentInspectionOptions = Readonly<{
  delayMs?: number;
  inspect: PatentInspector;
  cancel?: () => void;
  automaticMode?: InspectionMode;
}>;

const MAX_CACHED_PATENT_REPORTS = 20;

export type PatentInspectionState = Readonly<{
  report: PatentInspectionReport | null;
  fullReport: PatentInspectionReport | null;
  fullReportStale: boolean;
  stale: boolean;
  running: boolean;
  recheck(): Promise<void>;
  cancel(): void;
}>;

function reportCacheKey(patent: CanonicalPatent): string {
  // Several local edits may share one pending disk revision after save coalescing.
  const books = patent.books.map((book) => `${book.kind}:${book.localRevision}`).join(",");
  const auxiliary = patent.auxiliaryDocuments
    .map((book) => `${book.auxiliaryDocumentId}:${book.localRevision}`)
    .join(",");
  return `${patent.patentId}:${patent.revision}:${books}:${auxiliary}`;
}

export function usePatentInspection(
  patent: CanonicalPatent | null,
  { delayMs = 250, inspect, cancel, automaticMode = "full" }: UsePatentInspectionOptions,
): PatentInspectionState {
  const [report, setReport] = useState<PatentInspectionReport | null>(null);
  const [fullReport, setFullReport] = useState<PatentInspectionReport | null>(null);
  const fullReportCacheRef = useRef(new Map<string, PatentInspectionReport>());
  const [running, setRunning] = useState(false);
  const patentRef = useRef(patent);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const runningTargetRef = useRef<string | null>(null);
  const reportKeysRef = useRef(new WeakMap<PatentInspectionReport, string>());
  const mountedRef = useRef(true);
  const reportCacheRef = useRef(new Map<string, PatentInspectionReport>());
  patentRef.current = patent;

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const run = useCallback(
    async (target: CanonicalPatent, mode: InspectionMode = "full") => {
      const generation = ++generationRef.current;
      const targetKey = reportCacheKey(target);
      runningTargetRef.current = targetKey;
      setRunning(true);
      try {
        const nextReport = await inspect(target, mode);
        if (mountedRef.current && generation === generationRef.current) {
          reportKeysRef.current.set(nextReport, targetKey);
          const patentPrefix = `${target.patentId}:`;
          for (const key of reportCacheRef.current.keys()) {
            if (key.startsWith(patentPrefix)) reportCacheRef.current.delete(key);
          }
          reportCacheRef.current.set(reportCacheKey(target), nextReport);
          while (reportCacheRef.current.size > MAX_CACHED_PATENT_REPORTS) {
            const oldestKey = reportCacheRef.current.keys().next().value;
            if (oldestKey === undefined) break;
            reportCacheRef.current.delete(oldestKey);
          }
          setReport(nextReport);
          if (mode === "full") {
            fullReportCacheRef.current.delete(target.patentId);
            fullReportCacheRef.current.set(target.patentId, nextReport);
            while (fullReportCacheRef.current.size > MAX_CACHED_PATENT_REPORTS) {
              const oldest = fullReportCacheRef.current.keys().next().value;
              if (oldest === undefined) break;
              fullReportCacheRef.current.delete(oldest);
            }
            setFullReport(nextReport);
          }
        }
      } catch {
        if (mountedRef.current && generation === generationRef.current) {
          reportCacheRef.current.delete(reportCacheKey(target));
          const failed = failedInspectionReport(target);
          reportKeysRef.current.set(failed, targetKey);
          setReport(failed);
          if (mode === "full") {
            fullReportCacheRef.current.delete(target.patentId);
            setFullReport(failed);
          }
        }
      } finally {
        if (mountedRef.current && generation === generationRef.current) {
          runningTargetRef.current = null;
          setRunning(false);
        }
      }
    },
    [inspect],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      cancel?.();
      clearTimer();
    };
  }, [clearTimer, cancel]);

  useEffect(() => {
    clearTimer();
    if (!patent || fullReport?.patentId !== patent.patentId) {
      setFullReport(patent ? (fullReportCacheRef.current.get(patent.patentId) ?? null) : null);
    }
    const alreadyRunningCurrentRevision =
      patent !== null && runningTargetRef.current === reportCacheKey(patent);
    if (!alreadyRunningCurrentRevision) {
      generationRef.current += 1;
      runningTargetRef.current = null;
      cancel?.();
      setRunning(false);
    }
    if (!patent) {
      setReport(null);
      return;
    }
    const cached = reportCacheRef.current.get(reportCacheKey(patent));
    if (cached?.engineVersion === PATENT_INSPECTION_ENGINE_VERSION) {
      reportCacheRef.current.delete(reportCacheKey(patent));
      reportCacheRef.current.set(reportCacheKey(patent), cached);
      setReport(cached);
      return;
    }
    if (alreadyRunningCurrentRevision) return;
    if (report === null || report.patentId !== patent.patentId) {
      void run(patent, automaticMode);
      return;
    }
    if (reportKeysRef.current.get(report) === reportCacheKey(patent)) return;
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        void run(patent, automaticMode);
      },
      Math.max(0, delayMs),
    );
    return clearTimer;
  }, [clearTimer, delayMs, patent, report, fullReport, run, automaticMode, cancel]);

  const recheck = useCallback(async () => {
    clearTimer();
    const current = patentRef.current;
    if (!current) return;
    await run(current);
  }, [clearTimer, run]);

  const cancelInspection = useCallback(() => {
    clearTimer();
    generationRef.current += 1;
    runningTargetRef.current = null;
    cancel?.();
    setRunning(false);
  }, [cancel, clearTimer]);

  const stale =
    patent !== null &&
    (report === null ||
      report.patentId !== patent.patentId ||
      report.patentRevision !== patent.revision ||
      reportKeysRef.current.get(report) !== reportCacheKey(patent) ||
      report.engineVersion !== PATENT_INSPECTION_ENGINE_VERSION);

  const fullReportStale =
    patent !== null &&
    (fullReport === null ||
      fullReport.patentId !== patent.patentId ||
      fullReport.patentRevision !== patent.revision ||
      reportKeysRef.current.get(fullReport) !== reportCacheKey(patent) ||
      fullReport.engineVersion !== PATENT_INSPECTION_ENGINE_VERSION);
  return { report, fullReport, fullReportStale, stale, running, recheck, cancel: cancelInspection };
}

function failedInspectionReport(patent: CanonicalPatent): PatentInspectionReport {
  return {
    engineVersion: PATENT_INSPECTION_ENGINE_VERSION,
    patentId: patent.patentId,
    patentRevision: patent.revision,
    mode: "full",
    checkedAt: new Date().toISOString(),
    issues: [],
    degradedRules: [{ ruleId: "engine", message: "该项检查未完成。" }],
  };
}

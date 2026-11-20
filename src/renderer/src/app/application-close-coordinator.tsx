import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { AppError } from "../../../shared/ipc/result";
import { showApplicationError } from "../shared/error-dialog";
import { ApplicationExitProgress } from "./application-exit-progress";

export type ApplicationClosePreparation = {
  /** Apply approved changes only after every participant has agreed to exit. */
  commit(): Promise<boolean>;
  /** Release retained input/resources if exit is cancelled or fails. Must not destroy the session. */
  cancel(): Promise<void>;
};
type ApplicationCloseParticipant = () => Promise<boolean | ApplicationClosePreparation>;
export type ApplicationClosePhase = "editor" | "aggregate" | "backup";
export type ApplicationFlushReason = "application-close" | "full-data-transfer" | "background-save";
type ApplicationCloseParticipantOptions = {
  reasons?: readonly ApplicationFlushReason[];
};

export type ApplicationFlushReport = {
  ok: boolean;
  failedParticipantIds: string[];
};

export type ApplicationPersistence = {
  register(
    participantId: string,
    participant: ApplicationCloseParticipant,
    phase?: ApplicationClosePhase,
    options?: ApplicationCloseParticipantOptions,
  ): () => void;
  registerCloseGuard(participantId: string, participant: ApplicationCloseParticipant): () => void;
  flushAll(reason: ApplicationFlushReason): Promise<ApplicationFlushReport>;
};

type ParticipantRegistration = {
  participant: ApplicationCloseParticipant;
  phase: ApplicationClosePhase;
  reasons: readonly ApplicationFlushReason[];
  token: symbol;
};

type InFlightFlush = {
  closeGuardSnapshot: Array<[string, ParticipantRegistration]>;
  reason: ApplicationFlushReason;
  applicationCloseRequested: boolean;
  participantThrew: boolean;
  errorShown: boolean;
  promise: Promise<ApplicationFlushReport>;
};

const MAX_PARTICIPANT_ID_LENGTH = 160;
const ApplicationClosingContext = createContext(false);
export function useApplicationClosing() {
  return useContext(ApplicationClosingContext);
}

const ApplicationPersistenceContext = createContext<ApplicationPersistence | null>(null);

function appError(error: unknown): AppError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return error as AppError;
  }
  return { code: "INTERNAL", message: "Local application close failed" };
}

export function ApplicationCloseProvider({ children }: PropsWithChildren) {
  const [closing, setClosing] = useState(false);
  const [closePhase, setClosePhase] = useState<ApplicationClosePhase>("editor");
  const [cancelling, setCancelling] = useState(false);
  const closeCancelled = useRef(false);
  const participants = useRef(new Map<string, ParticipantRegistration>());
  const closeGuards = useRef(new Map<string, ParticipantRegistration>());
  const handledTokens = useRef(new Set<string>());
  const inFlightFlush = useRef<InFlightFlush | null>(null);

  const register = useCallback<ApplicationPersistence["register"]>(
    (participantId, participant, phase = "aggregate", options = {}) => {
      if (participantId.trim().length === 0) throw new Error("Participant id must not be blank");
      if (participantId.length > MAX_PARTICIPANT_ID_LENGTH) {
        throw new Error(`Participant id must not exceed ${MAX_PARTICIPANT_ID_LENGTH} characters`);
      }
      const registration = {
        participant,
        phase,
        reasons: options.reasons ?? ["application-close", "full-data-transfer", "background-save"],
        token: Symbol(participantId),
      };
      participants.current.set(participantId, registration);
      return () => {
        if (participants.current.get(participantId)?.token === registration.token) {
          participants.current.delete(participantId);
        }
      };
    },
    [],
  );

  const registerCloseGuard = useCallback<ApplicationPersistence["registerCloseGuard"]>(
    (participantId, participant) => {
      if (participantId.trim().length === 0) throw new Error("Participant id must not be blank");
      if (participantId.length > MAX_PARTICIPANT_ID_LENGTH) {
        throw new Error(`Participant id must not exceed ${MAX_PARTICIPANT_ID_LENGTH} characters`);
      }
      const registration = {
        participant,
        phase: "aggregate" as const,
        reasons: ["application-close"] as const,
        token: Symbol(participantId),
      };
      closeGuards.current.set(participantId, registration);
      return () => {
        if (closeGuards.current.get(participantId)?.token === registration.token) {
          closeGuards.current.delete(participantId);
        }
      };
    },
    [],
  );

  const flushAll = useCallback<ApplicationPersistence["flushAll"]>(function executeFlush(
    reason,
  ): Promise<ApplicationFlushReport> {
    const currentFlush = inFlightFlush.current;
    if (currentFlush) {
      if (currentFlush.reason === "background-save" && reason !== "background-save") {
        return currentFlush.promise.then(() => executeFlush(reason));
      }
      if (reason === "application-close" && currentFlush.reason === "full-data-transfer") {
        currentFlush.applicationCloseRequested = true;
        if (currentFlush.closeGuardSnapshot.length === 0) return currentFlush.promise;
        return Promise.all(
          currentFlush.closeGuardSnapshot.map(async ([participantId, registration]) => {
            try {
              return { participantId, succeeded: await registration.participant() };
            } catch {
              currentFlush.participantThrew = true;
              return { participantId, succeeded: false };
            }
          }),
        ).then(async (results): Promise<ApplicationFlushReport> => {
          if (currentFlush.participantThrew && !currentFlush.errorShown) {
            currentFlush.errorShown = true;
            showApplicationError({ code: "INTERNAL", message: "Local application close failed" });
          }
          const failedParticipantIds = results
            .filter((result) => !result.succeeded)
            .map((result) => result.participantId);
          const report = failedParticipantIds.length
            ? { ok: false, failedParticipantIds }
            : await currentFlush.promise;
          const preparations = results.filter((item) => typeof item.succeeded === "object");
          for (const item of preparations) {
            const preparation = item.succeeded as ApplicationClosePreparation;
            try {
              if (!report.ok || closeCancelled.current || !(await preparation.commit())) {
                await preparation.cancel();
                return {
                  ok: false,
                  failedParticipantIds: [...report.failedParticipantIds, item.participantId],
                };
              }
            } catch (error) {
              await preparation.cancel().catch(() => undefined);
              showApplicationError(appError(error));
              return { ok: false, failedParticipantIds: [item.participantId] };
            }
          }
          return report;
        });
      }
      if (reason === "application-close") currentFlush.applicationCloseRequested = true;
      return currentFlush.promise;
    }

    const closeGuardSnapshot = [...closeGuards.current.entries()];
    const participantSnapshot = [...participants.current.entries()].filter(([, registration]) =>
      registration.reasons.includes(reason),
    );
    const flush: InFlightFlush = {
      closeGuardSnapshot,
      reason,
      applicationCloseRequested: reason === "application-close",
      participantThrew: false,
      errorShown: false,
      promise: Promise.resolve({ ok: true, failedParticipantIds: [] }),
    };
    const preparations: Array<{ participantId: string; preparation: ApplicationClosePreparation }> =
      [];
    const runRegistrations = async (
      registrations: Array<[string, ParticipantRegistration]>,
    ): Promise<ApplicationFlushReport> => {
      if (reason === "application-close") {
        if (closeCancelled.current)
          return { ok: false, failedParticipantIds: ["application-close-cancelled"] };
        setClosePhase(registrations[0]?.[1].phase ?? "aggregate");
      }
      const results = await Promise.all(
        registrations.map(async ([participantId, registration]) => {
          try {
            return { participantId, succeeded: await registration.participant() };
          } catch {
            flush.participantThrew = true;
            return { participantId, succeeded: false };
          }
        }),
      );
      const failedParticipantIds = results
        .filter((result) => !result.succeeded)
        .map((result) => result.participantId);
      for (const result of results)
        if (typeof result.succeeded === "object")
          preparations.push({ participantId: result.participantId, preparation: result.succeeded });
      if (reason === "application-close" && closeCancelled.current)
        failedParticipantIds.push("application-close-cancelled");
      return { ok: failedParticipantIds.length === 0, failedParticipantIds };
    };
    const editorRegistrations = participantSnapshot.filter(
      ([, registration]) => registration.phase === "editor",
    );
    const aggregateRegistrations = [
      ...participantSnapshot.filter(([, registration]) => registration.phase === "aggregate"),
      ...(reason === "application-close" ? closeGuardSnapshot : []),
    ];
    const backupRegistrations = participantSnapshot.filter(
      ([, registration]) => registration.phase === "backup",
    );
    const finishReport = async (report: ApplicationFlushReport) => {
      try {
        if (report.ok && !closeCancelled.current) {
          for (const item of preparations) {
            if (!(await item.preparation.commit()))
              return { ok: false, failedParticipantIds: [item.participantId] };
          }
        }
      } catch (error) {
        flush.participantThrew = true;
        return { ok: false, failedParticipantIds: preparations.map((item) => item.participantId) };
      } finally {
        // Both successful and cancelled preparations must release their input locks.
        await Promise.allSettled(preparations.map((item) => item.preparation.cancel()));
      }
      if (flush.applicationCloseRequested && flush.participantThrew && !flush.errorShown) {
        flush.errorShown = true;
        showApplicationError({ code: "INTERNAL", message: "Local application close failed" });
      }
      return report;
    };
    const operation =
      editorRegistrations.length === 0
        ? runRegistrations(aggregateRegistrations).then(async (aggregateReport) =>
            aggregateReport.ok
              ? runRegistrations(backupRegistrations).then(finishReport)
              : finishReport(aggregateReport),
          )
        : runRegistrations(editorRegistrations).then((editorReport) =>
            editorReport.ok
              ? runRegistrations(aggregateRegistrations).then(async (aggregateReport) =>
                  aggregateReport.ok
                    ? runRegistrations(backupRegistrations).then(finishReport)
                    : finishReport(aggregateReport),
                )
              : finishReport(editorReport),
          );
    flush.promise = operation;
    inFlightFlush.current = flush;
    void operation.then(
      () => {
        if (inFlightFlush.current === flush) inFlightFlush.current = null;
      },
      () => {
        if (inFlightFlush.current === flush) inFlightFlush.current = null;
      },
    );
    return operation;
  }, []);

  const persistence = useMemo<ApplicationPersistence>(
    () => ({ register, registerCloseGuard, flushAll }),
    [flushAll, register, registerCloseGuard],
  );

  useEffect(() => {
    const applicationApi = window.patentApi.application;
    if (!applicationApi.onPrepareClose) return;
    const heartbeats = new Set<ReturnType<typeof setInterval>>();
    const unsubscribe = applicationApi.onPrepareClose((token) => {
      if (handledTokens.current.has(token)) return;
      handledTokens.current.add(token);
      void (async () => {
        closeCancelled.current = false;
        setCancelling(false);
        setClosePhase("editor");
        flushSync(() => setClosing(true));
        const heartbeat = () => {
          void applicationApi.closeHeartbeat?.(token).catch(() => undefined);
        };
        heartbeat();
        const timer = setInterval(heartbeat, 2_000);
        heartbeats.add(timer);
        try {
          const report = await flushAll("application-close");
          const proceed = report.ok && !closeCancelled.current;
          const result = await applicationApi.closeResult({ token, proceed });
          if (!proceed || !result.ok)
            window.dispatchEvent(new Event("workbench:application-close-cancelled"));
          if (!result.ok) showApplicationError(result.error);
        } catch (error) {
          showApplicationError(appError(error));
          await applicationApi.closeResult({ token, proceed: false }).catch(() => undefined);
          window.dispatchEvent(new Event("workbench:application-close-cancelled"));
        } finally {
          clearInterval(timer);
          heartbeats.delete(timer);
          setClosing(false);
        }
      })();
    });
    return () => {
      unsubscribe();
      for (const timer of heartbeats) clearInterval(timer);
    };
  }, [flushAll]);

  useEffect(() => {
    const api = window.patentApi.application;
    return api.onBackgroundSave?.((token) => {
      void (async () => {
        const report = await flushAll("background-save");
        try {
          const result = await api.backgroundSaveResult?.({ token, ok: report.ok });
          if (result && !result.ok) showApplicationError(result.error);
        } catch (error) {
          showApplicationError(appError(error));
        }
      })();
    });
  }, [flushAll]);

  return (
    <ApplicationPersistenceContext.Provider value={persistence}>
      <ApplicationClosingContext.Provider value={closing}>
        {children}
        {closing ? (
          <ApplicationExitProgress
            phase={closePhase}
            cancelling={cancelling}
            onCancel={() => {
              closeCancelled.current = true;
              setCancelling(true);
            }}
          />
        ) : null}
      </ApplicationClosingContext.Provider>
    </ApplicationPersistenceContext.Provider>
  );
}

export function useApplicationPersistence(): ApplicationPersistence {
  const persistence = useContext(ApplicationPersistenceContext);
  if (!persistence) {
    throw new Error("useApplicationPersistence must be used within ApplicationCloseProvider");
  }
  return persistence;
}

export function useApplicationCloseParticipant(
  participantId: string,
  participant: ApplicationCloseParticipant,
  phase: ApplicationClosePhase = "aggregate",
  options?: ApplicationCloseParticipantOptions,
) {
  const persistence = useApplicationPersistence();
  useEffect(
    () => persistence.register(participantId, participant, phase, options),
    [participantId, participant, persistence, phase, options],
  );
}

export function useApplicationCloseGuard(
  participantId: string,
  participant: ApplicationCloseParticipant,
) {
  const persistence = useApplicationPersistence();
  useEffect(
    () => persistence.registerCloseGuard(participantId, participant),
    [participantId, participant, persistence],
  );
}

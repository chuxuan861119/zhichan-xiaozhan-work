import { Worker } from "node:worker_threads";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { patentDocumentSnapshot } from "../../shared/patent/snapshot-scope.js";

import {
  encodePatentDocumentSnapshot,
  encodePatentRecoverySnapshot,
  encodePatentSnapshot,
} from "./edit-journal.js";

export type SnapshotWorkerJob = {
  patentId: string;
  revision: number;
  modelVersion: 2 | 3;
  patent: CanonicalPatent;
  scope?: "documents";
};

export type SnapshotWorkerResult = {
  revision: number;
  modelVersion: 2 | 3;
  payload: Buffer;
  contentHash: string;
};

export function createSnapshotPayload(job: SnapshotWorkerJob): SnapshotWorkerResult {
  const snapshot =
    job.scope === "documents"
      ? encodePatentDocumentSnapshot(job.patent)
      : job.modelVersion === 3
        ? encodePatentRecoverySnapshot(job.patent)
        : encodePatentSnapshot(job.patent, 2);
  return {
    revision: job.revision,
    modelVersion: job.modelVersion,
    payload: snapshot.payload,
    contentHash: snapshot.contentHash,
  };
}

const SNAPSHOT_WORKER_SOURCE = `
const { createHash } = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const value = workerData.modelVersion === 3 ? {
    formatVersion: workerData.scope === "documents" ? 3 : 1,
    patent: workerData.patent,
  } : workerData.patent;
const json = JSON.stringify(value);
parentPort.postMessage({
  revision: workerData.revision,
  modelVersion: workerData.modelVersion,
  payload: Buffer.from(json, "utf8"),
  contentHash: createHash("sha256").update(json, "utf8").digest("hex"),
});
`;

export async function createSnapshotPayloadInWorker(
  job: SnapshotWorkerJob,
): Promise<SnapshotWorkerResult> {
  return await new Promise<SnapshotWorkerResult>((resolve, reject) => {
    const worker = new Worker(SNAPSHOT_WORKER_SOURCE, {
      eval: true,
      workerData: {
        patentId: job.patentId,
        revision: job.revision,
        modelVersion: job.modelVersion,
        scope: job.scope,
        patent: job.scope === "documents" ? patentDocumentSnapshot(job.patent) : job.patent,
      },
    });
    worker.once(
      "message",
      (value: Omit<SnapshotWorkerResult, "payload"> & { payload: Uint8Array }) => {
        resolve({ ...value, payload: Buffer.from(value.payload) });
      },
    );
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Snapshot worker stopped with exit code ${code}.`));
    });
  });
}

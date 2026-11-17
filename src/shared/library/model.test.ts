import {
  LibraryDocumentIdSchema,
  LibraryDocumentSummarySchema,
  LibraryEditAckSchema,
  LibraryPatentSummarySchema,
  LibraryRevisionSchema,
  LibrarySaveStateSchema,
} from "./model.js";

const healthySummary = {
  libraryDocumentId: "0a1fbf8d-52fe-4a14-98df-c18bbac5e428",
  title: "往复式夹具",
  snippet: "本发明涉及…",
  revision: 7,
  saveState: "saved" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  modifiedAt: "2026-08-01T00:01:00.000Z",
  deletedAt: null,
  quarantinedAt: null,
  recoveryState: "healthy" as const,
  recoveryErrorCode: null,
};

test("accepts a persisted library summary and rejects invalid revisions", () => {
  expect(LibraryDocumentSummarySchema.parse(healthySummary)).toEqual(healthySummary);
  expect(LibraryDocumentSummarySchema.safeParse({ ...healthySummary, revision: -1 }).success).toBe(
    false,
  );
});

test("accepts a patent-level library summary with five book statuses", () => {
  const summary = {
    patentId: "0a1fbf8d-52fe-4a14-98df-c18bbac5e428",
    name: null,
    customer: null,
    patentType: "utility-model" as const,
    revision: 0,
    bookStatuses: {
      claims: "empty" as const,
      description: "draft" as const,
      "description-drawings": "empty" as const,
      abstract: "empty" as const,
      "abstract-drawing": "empty" as const,
    },
    issueCount: 9,
    saveState: "saved" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    modifiedAt: "2026-08-01T00:01:00.000Z",
    deletedAt: null,
    recoveryState: "healthy" as const,
    recoveryErrorCode: null,
  };

  expect(LibraryPatentSummarySchema.parse(summary)).toEqual(summary);
  expect(LibraryPatentSummarySchema.safeParse({ ...summary, issueCount: -1 }).success).toBe(false);
  expect(
    LibraryPatentSummarySchema.safeParse({
      ...summary,
      bookStatuses: { ...summary.bookStatuses, claims: "unknown" },
    }).success,
  ).toBe(false);
});

test("accepts unavailable statuses for a patent whose books cannot be read", () => {
  const summary = {
    patentId: "0a1fbf8d-52fe-4a14-98df-c18bbac5e428",
    name: "待恢复专利",
    customer: null,
    patentType: "invention" as const,
    revision: 3,
    bookStatuses: {
      claims: "unavailable" as const,
      description: "unavailable" as const,
      "description-drawings": "unavailable" as const,
      abstract: "unavailable" as const,
      "abstract-drawing": "unavailable" as const,
    },
    issueCount: 1,
    saveState: "saved" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    modifiedAt: "2026-08-01T00:01:00.000Z",
    deletedAt: null,
    recoveryState: "quarantined" as const,
    recoveryErrorCode: "CORRUPT_FILE",
  };

  expect(LibraryPatentSummarySchema.parse(summary)).toEqual(summary);
});

test("requires UUID library IDs, integer revisions, and the three save states", () => {
  expect(LibraryDocumentIdSchema.safeParse(healthySummary.libraryDocumentId).success).toBe(true);
  expect(LibraryDocumentIdSchema.safeParse("document-1").success).toBe(false);
  expect(LibraryRevisionSchema.safeParse(1.5).success).toBe(false);
  expect(LibrarySaveStateSchema.options).toEqual(["saving", "saved", "failed"]);
});

test("accepts trash deletion metadata and rejects malformed timestamps", () => {
  expect(
    LibraryDocumentSummarySchema.safeParse({
      ...healthySummary,
      deletedAt: "2026-08-01T00:02:00.000Z",
    }).success,
  ).toBe(true);
  expect(
    LibraryDocumentSummarySchema.safeParse({ ...healthySummary, deletedAt: "60 days ago" }).success,
  ).toBe(false);
});

test("keeps healthy and quarantined recovery metadata consistent", () => {
  expect(
    LibraryDocumentSummarySchema.safeParse({
      ...healthySummary,
      quarantinedAt: healthySummary.modifiedAt,
    }).success,
  ).toBe(false);
  expect(
    LibraryDocumentSummarySchema.safeParse({
      ...healthySummary,
      recoveryState: "quarantined",
      quarantinedAt: healthySummary.modifiedAt,
      recoveryErrorCode: "CORRUPT_SNAPSHOT",
    }).success,
  ).toBe(true);
  expect(
    LibraryDocumentSummarySchema.safeParse({
      ...healthySummary,
      recoveryState: "quarantined",
      recoveryErrorCode: "CORRUPT_SNAPSHOT",
    }).success,
  ).toBe(false);
});

test.each(["", "   ", "corrupt-snapshot", "CORRUPT SNAPSHOT", "1_CORRUPT"])(
  "rejects an invalid recovery error code %j",
  (recoveryErrorCode) => {
    expect(
      LibraryDocumentSummarySchema.safeParse({
        ...healthySummary,
        recoveryState: "quarantined",
        quarantinedAt: healthySummary.modifiedAt,
        recoveryErrorCode,
      }).success,
    ).toBe(false);
  },
);

test("trims a valid recovery error code", () => {
  expect(
    LibraryDocumentSummarySchema.parse({
      ...healthySummary,
      recoveryState: "quarantined",
      quarantinedAt: healthySummary.modifiedAt,
      recoveryErrorCode: "  CORRUPT_SNAPSHOT  ",
    }).recoveryErrorCode,
  ).toBe("CORRUPT_SNAPSHOT");
});

test("strictly validates persisted edit acknowledgements", () => {
  const acknowledgement = {
    libraryDocumentId: healthySummary.libraryDocumentId,
    operationId: "aa38551f-a08d-449b-99b4-a37dc514e484",
    revision: 8,
    savedAt: "2026-08-01T00:02:00.000Z",
  };

  expect(LibraryEditAckSchema.parse(acknowledgement)).toEqual(acknowledgement);
  expect(LibraryEditAckSchema.safeParse({ ...acknowledgement, revision: -1 }).success).toBe(false);
  expect(LibraryEditAckSchema.safeParse({ ...acknowledgement, unexpected: true }).success).toBe(
    false,
  );
});

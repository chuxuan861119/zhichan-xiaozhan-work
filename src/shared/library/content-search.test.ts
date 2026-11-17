import { expect, test } from "vitest";
import { ContentSearchRequestSchema } from "./content-search.js";

const request = (offset: number) => ({
  action: "search-details",
  query: "关键词",
  patentId: "p1",
  offset,
});

test.each([100000, 100020, 1_000_000, Number.MAX_SAFE_INTEGER])(
  "accepts safe detail offset %s without a document-size cap",
  (offset) => {
    expect(ContentSearchRequestSchema.safeParse(request(offset)).success).toBe(true);
  },
);
test.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid detail offset %s",
  (offset) => {
    expect(ContentSearchRequestSchema.safeParse(request(offset)).success).toBe(false);
  },
);

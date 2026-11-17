import type { TextCounts } from "../editor/rich-text-editor-core";
import { selectPatentTextCounts } from "./patent-text-counts";

test("selects counts for the active patent book target", () => {
  const counts: TextCounts = {
    chineseCharacters: 100,
    totalCharacters: 123,
    selectedCharacters: 0,
  };
  const byTarget = { "patent-1:claims": counts };

  expect(selectPatentTextCounts(byTarget, { patentId: "patent-1", bookKind: "claims" })).toEqual(
    counts,
  );
  expect(
    selectPatentTextCounts(byTarget, {
      patentId: "patent-1",
      bookKind: "description-drawings",
    }),
  ).toBeNull();
  expect(
    selectPatentTextCounts(byTarget, { patentId: "patent-1", bookKind: "abstract" }),
  ).toBeNull();
});

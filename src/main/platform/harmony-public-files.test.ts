import { expect, test } from "vitest";
import { usesHarmonyPublicFileCopy } from "./harmony-public-files.js";

test.each(["openharmony", "ohos"])("%s uses copying only for public files", (platform) => {
  expect(
    usesHarmonyPublicFileCopy("/storage/Users/currentUser/Download/test.zxwbackup", platform),
  ).toBe(true);
  expect(usesHarmonyPublicFileCopy("/data/storage/el2/base/files/test.zxwbackup", platform)).toBe(
    false,
  );
});
test.each(["win32", "darwin"])("%s keeps the existing publication path", (platform) => {
  expect(
    usesHarmonyPublicFileCopy("/storage/Users/currentUser/Download/test.zxwbackup", platform),
  ).toBe(false);
});

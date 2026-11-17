import { realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalSystemPath } from "./system-path.js";

test.runIf(process.platform === "darwin")(
  "normalizes system aliases without resolving arbitrary library links",
  () => {
    expect(canonicalSystemPath("/var/new-library")).toBe(join(realpathSync("/var"), "new-library"));
    expect(canonicalSystemPath("/Users/example/link/library")).toBe("/Users/example/link/library");
  },
);

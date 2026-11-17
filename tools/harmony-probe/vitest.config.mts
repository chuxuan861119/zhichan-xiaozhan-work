import { isAbsolute, resolve } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.ts";

const app = process.env.HARMONY_PROBE_APP;
if (!app || !isAbsolute(app))
  throw new Error("Set HARMONY_PROBE_APP to an isolated prepared probe directory");
// Host contract tests only. These aliases do not modify production source.
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        "node:sqlite": resolve(app, "sqlite-adapted.cjs"),
        "write-file-atomic": resolve(app, "atomic-adapted.cjs"),
      },
    },
  }),
);

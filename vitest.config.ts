import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// Match the application's canonical Mac paths before filesystem fixtures spawn.
if (process.platform === "darwin") process.env.TMPDIR = realpathSync(tmpdir());

const { dependencyAllowPaths } = createRequire(import.meta.url)(
  "./build/dependency-resolution.cjs",
) as { dependencyAllowPaths(root: string): string[] };

export default defineConfig({
  // Match development resolution for junctions and partial worktree installations.
  server: { fs: { allow: dependencyAllowPaths(process.cwd()) } },
  test: {
    environment: "jsdom",
    globals: true,
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "tests/integration/**/*.test.tsx",
      "scripts/**/*.test.ts",
      "services/**/*.test.ts",
    ],
    coverage: {
      include: ["src/shared/**", "src/main/**", "src/renderer/src/**"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/renderer/src/main.tsx"],
    },
  },
});

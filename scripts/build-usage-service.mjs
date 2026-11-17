import { build } from "esbuild";

await build({
  entryPoints: ["services/usage-statistics/main.ts"],
  outfile: "out-usage-service/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
});

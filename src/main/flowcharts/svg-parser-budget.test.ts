// @vitest-environment node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { buildSync } from "esbuild";

test("namespace-heavy SVG is rejected within an isolated 64 MiB heap", () => {
  const compiled = buildSync({
    stdin: {
      contents: `
        import { SvgSanitizer } from './src/main/flowcharts/svg-sanitizer.ts';
        let opening = '', closing = '';
        for (let i = 0; i < 1800; i++) {
          opening += '<g xmlns:p' + i + '="urn:' + i + '">';
          closing += '</g>';
        }
        const input = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' + opening + '<rect width="1" height="1"/>' + closing + '</svg>';
        try {
          new SvgSanitizer().sanitize(input, { borderMm: 0 });
          throw new Error('unsafe namespace accepted');
        } catch (error) {
          if (error.code !== 'UNSAFE_SVG') throw error;
          process.stdout.write('rejected');
        }
      `,
      resolveDir: resolve(import.meta.dirname, "../../.."),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const result = spawnSync(process.execPath, ["--max-old-space-size=64"], {
    input: compiled.outputFiles[0]?.text,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("rejected");
}, 20_000);

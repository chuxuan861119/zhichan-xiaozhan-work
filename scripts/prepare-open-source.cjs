const { resolve, join } = require("node:path");
const { readFile } = require("node:fs/promises");
const {
  createSourceBundle,
  verifyPublishedBundle,
} = require("../build/open-source-distribution.cjs");

async function main() {
  const root = resolve(__dirname, "..");
  const args = process.argv.slice(2);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const version =
    value("--version") || JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const bundle = await createSourceBundle(root, {
    version,
    platform: value("--platform") || process.platform,
    arch: value("--arch") || process.arch,
  });
  if (args.includes("--verify-published")) await verifyPublishedBundle(bundle);
  console.log(
    JSON.stringify(
      {
        archive: bundle.archivePath,
        url: bundle.url,
        bytes: bundle.bytes,
        sha256: bundle.sha256,
        publishedVerified: args.includes("--verify-published"),
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

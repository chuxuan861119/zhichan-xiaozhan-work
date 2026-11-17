import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allowedAppPaths,
  CIRCUIT_RUNTIME_FILES,
  classifyDrawioPath,
  DRAWIO_POLICY,
} from "./drawio-bundle-policy.mjs";
import {
  buildPatentChineseResource,
  buildPatentLocalizationBootstrap,
  parseDrawioToolLabels,
} from "./vendor-drawio.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URI_REFERENCE =
  /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:data|blob):|\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,})[^\s"'<>]*/gu;
const XML_NAMESPACE_URLS = new Set([
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/TR/SVG11/feature#Extensibility",
  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd",
  "http://www.w3.org/2000/xmlns/",
]);
const ALLOWED_INLINE_SCHEMES = new Set(["data", "blob"]);
const ALLOWED_LOCAL_EDITOR_ORIGINS = new Set(["patent-app://app", "patent-diagram://editor"]);
const LICENSE_MATERIAL_HASHES = Object.freeze({
  LICENSE: "5ad8c213095c573921d7388edf93f6a9f54490b8ebf3b165ae8ef1947cf70846",
  NOTICE: "d60c041a6fbe2dd27c06d541e0475539618db6b7b67eb316bfab5f0983421f83",
  "THIRD_PARTY_NOTICES.md": "7111646672ff3cfc9d3764c24571bf21e26a15878c9d8ef98a6ebb7c87397d69",
});

export async function auditDrawioBundle(
  rootDirectory = ROOT,
  { listFiles: readBundleFiles = listFiles } = {},
) {
  const bundleRoot = join(rootDirectory, "resources", "drawio");
  const upstream = JSON.parse(await readFile(join(bundleRoot, "upstream.json"), "utf8"));
  if (
    JSON.stringify(upstream) !==
    JSON.stringify({
      ...DRAWIO_POLICY.upstream,
      languages: DRAWIO_POLICY.languages,
      libraries: DRAWIO_POLICY.libraries,
      templates: DRAWIO_POLICY.templates,
    })
  ) {
    throw new Error("resources/drawio/upstream.json does not match the pinned draw.io policy");
  }
  const manifest = JSON.parse(await readFile(join(bundleRoot, "manifest.json"), "utf8"));
  if (JSON.stringify(manifest.upstream) !== JSON.stringify(DRAWIO_POLICY.upstream)) {
    throw new Error("draw.io manifest upstream does not match the pinned policy");
  }
  await auditLicenseMaterials(rootDirectory);
  for (const file of CIRCUIT_RUNTIME_FILES) {
    const [source, generated] = await Promise.all([
      readFile(join(bundleRoot, "runtime", file)),
      readFile(join(bundleRoot, "app", file)),
    ]);
    if (!generated.equals(source)) {
      throw new Error(`draw.io circuit runtime ${file} is out of date; run npm run vendor:drawio`);
    }
  }
  if (!Array.isArray(manifest.files)) throw new Error("draw.io manifest files must be an array");
  const manifestPaths = manifest.files.map((entry) => entry?.path);
  for (const path of manifestPaths) {
    if (!isCanonicalBundlePath(path))
      throw new Error(`draw.io manifest path is not canonical: ${path}`);
  }
  if (new Set(manifestPaths).size !== manifestPaths.length) {
    throw new Error("draw.io manifest contains duplicate paths");
  }
  const files = await readBundleFiles(bundleRoot);
  // This first-party UI hook is not part of draw.io's upstream license inventory.
  const surfaceHook = "app/surface-adaptation.js";
  if (files.includes(surfaceHook)) {
    const bytes = await readFile(join(bundleRoot, surfaceHook));
    if (sha256(bytes) !== "10f43619e003ec4f0b3fe8fad520c8b353fe22ae4a76dd598ce6df939a83d577") {
      throw new Error("draw.io first-party surface adaptation hook hash mismatch");
    }
  }
  const productionFiles = files.filter(
    (file) =>
      file !== "manifest.json" &&
      file !== "upstream.json" &&
      file !== surfaceHook &&
      !file.startsWith("localization/") &&
      !CIRCUIT_RUNTIME_FILES.some((runtime) => file === `runtime/${runtime}`),
  );
  if (
    JSON.stringify(manifestPaths) !==
    JSON.stringify([...manifestPaths].sort((a, b) => a.localeCompare(b, "en")))
  ) {
    throw new Error("draw.io manifest paths are not sorted");
  }
  if (
    JSON.stringify(productionFiles.sort((a, b) => a.localeCompare(b, "en"))) !==
    JSON.stringify(manifestPaths)
  ) {
    throw new Error("draw.io manifest files do not match the production bundle");
  }
  for (const path of manifestPaths) {
    if (
      path.startsWith("templates/") &&
      !DRAWIO_POLICY.templates.some((name) => path === `templates/${name}.drawio`)
    ) {
      throw new Error(`draw.io bundle includes an unapproved template: ${path}`);
    }
  }
  const expectedPaths = [
    ...allowedAppPaths().map((path) => `app/${path}`),
    ...DRAWIO_POLICY.templates.map((name) => `templates/${name}.drawio`),
  ].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(manifestPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("draw.io manifest does not contain the complete approved runtime allowlist");
  }
  for (const entry of manifest.files) {
    const path = entry.path;
    const appRelative = path.startsWith("app/") ? path.slice(4) : null;
    const allowed = appRelative
      ? classifyDrawioPath(appRelative) === "allow"
      : DRAWIO_POLICY.templates.some((name) => path === `templates/${name}.drawio`);
    if (!allowed) throw new Error(`draw.io bundle includes a disallowed file: ${path}`);
    const bytes = await readFile(join(bundleRoot, path));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== entry.sha256 || bytes.byteLength !== entry.bytes) {
      throw new Error(`draw.io bundle hash mismatch: ${path}`);
    }
    const isGeneratedOrHtml =
      path === "app/adapter.js" ||
      path === "app/embed-config.js" ||
      path === "app/embed-bridge.js" ||
      CIRCUIT_RUNTIME_FILES.some((runtime) => path === `app/${runtime}`) ||
      path === "app/patent-localization.js" ||
      path.endsWith(".html");
    const isLocalizedText =
      path === "app/resources/dia.txt" ||
      path === "app/resources/dia_zh.txt" ||
      path === "app/resources/patent_zh.txt";
    const uris =
      isGeneratedOrHtml || isLocalizedText
        ? (bytes.toString("utf8").match(URI_REFERENCE) ?? [])
        : [];
    if (uris.some((uri) => !isAllowedUri(uri))) {
      throw new Error(`draw.io bundle includes an external URL: ${path}`);
    }
  }
  const expectedPatentChinese = buildPatentChineseResource(
    await readFile(join(bundleRoot, "app", "resources", "dia_zh.txt"), "utf8"),
    await readFile(join(bundleRoot, "localization", "zh-cn-overrides.txt"), "utf8"),
  );
  const actualPatentChinese = await readFile(
    join(bundleRoot, "app", "resources", "patent_zh.txt"),
    "utf8",
  );
  if (actualPatentChinese !== expectedPatentChinese) {
    throw new Error("draw.io localization consistency check failed");
  }
  const expectedLocalization = buildPatentLocalizationBootstrap(
    await readFile(join(bundleRoot, "app", "resources", "dia.txt"), "utf8"),
    await readFile(join(bundleRoot, "app", "resources", "dia_zh.txt"), "utf8"),
    parseDrawioToolLabels(
      await readFile(join(bundleRoot, "localization", "tool-labels-zh.json"), "utf8"),
    ),
  );
  const actualLocalization = await readFile(
    join(bundleRoot, "app", "patent-localization.js"),
    "utf8",
  );
  if (actualLocalization !== expectedLocalization) {
    throw new Error("draw.io tool localization consistency check failed");
  }
  await auditEditorEntryDependencies(bundleRoot, new Set(manifestPaths));
  return "draw.io v30.0.4 bundle audit passed";
}

async function auditEditorEntryDependencies(bundleRoot, manifestPaths) {
  for (const entry of ["index.html", "adapter.html", "embed.html"]) {
    const index = await readFile(join(bundleRoot, "app", entry), "utf8");
    const references = index.matchAll(/\b(?:src|href)=["']([^"']+)["']/giu);
    for (const match of references) {
      const reference = match[1];
      if (!reference || /^(?:data:|blob:|https?:|\/\/)/iu.test(reference)) continue;
      let resolved;
      try {
        resolved = new URL(reference, `patent-diagram://editor/${entry}`);
      } catch {
        throw new Error(
          `draw.io editor entry has an invalid local runtime dependency: ${reference}`,
        );
      }
      const relativePath = decodeURIComponent(resolved.pathname).replace(/^\/+/, "");
      if (
        resolved.protocol !== "patent-diagram:" ||
        resolved.hostname !== "editor" ||
        resolved.search ||
        resolved.hash ||
        (!manifestPaths.has(`app/${relativePath}`) &&
          !["workbench-ui.css", "workbench-ui.js", "surface-adaptation.js"].includes(relativePath))
      ) {
        throw new Error(
          `draw.io editor entry has an unapproved local runtime dependency: ${reference}`,
        );
      }
      if (["workbench-ui.css", "workbench-ui.js"].includes(relativePath)) {
        await readFile(join(dirname(bundleRoot), "ui", relativePath));
      }
      if (relativePath === "surface-adaptation.js") {
        const bytes = await readFile(join(bundleRoot, "app", relativePath));
        if (sha256(bytes) !== "10f43619e003ec4f0b3fe8fad520c8b353fe22ae4a76dd598ce6df939a83d577")
          throw new Error("draw.io first-party surface adaptation hook hash mismatch");
      }
    }
  }
}

function isAllowedUri(uri) {
  if (XML_NAMESPACE_URLS.has(uri)) return true;
  if (ALLOWED_LOCAL_EDITOR_ORIGINS.has(uri.replace(/\/$/u, ""))) return true;
  const scheme = uri.slice(0, uri.indexOf(":")).toLowerCase();
  return ALLOWED_INLINE_SCHEMES.has(scheme);
}

async function auditLicenseMaterials(rootDirectory) {
  const names = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];
  for (const name of names) {
    const expected = await readFile(join(ROOT, "resources", "licenses", "drawio", name));
    const actual = await readFile(join(rootDirectory, "resources", "licenses", "drawio", name));
    const expectedHash = LICENSE_MATERIAL_HASHES[name];
    if (
      !actual.equals(expected) ||
      sha256(expected) !== expectedHash ||
      sha256(actual) !== expectedHash
    )
      throw new Error(`draw.io ${name} does not match the pinned upstream materials`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCanonicalBundlePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`draw.io bundle contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) files.push(...(await listFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await auditDrawioBundle());
  } catch (error) {
    console.error(
      `draw.io bundle audit failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

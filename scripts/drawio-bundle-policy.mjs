const UPSTREAM_ROOT = "src/main/webapp/";

export const CIRCUIT_RUNTIME_FILES = Object.freeze([
  "circuit-domain.js",
  "circuit-component-policy.js",
  "circuit-quick-wiring.js",
  "drawing-tools.js",
]);

export const DRAWIO_POLICY = Object.freeze({
  upstream: Object.freeze({
    repository: "https://github.com/jgraph/drawio",
    tag: "v30.0.4",
    commit: "88ee1f5ab4d40603a8f3aaa0d9d6dc3794c6b3f0",
    license: "Apache-2.0",
  }),
  languages: Object.freeze(["zh", "en"]),
  libraries: Object.freeze(["arrows", "basic", "bpmn", "flowchart"]),
  templates: Object.freeze(["patent-basic-flowchart", "patent-system-flow", "patent-method-flow"]),
  appFiles: Object.freeze([
    "index.html",
    "js/bootstrap.js",
    "js/PreConfig.js",
    "js/app.min.js",
    "js/extensions.min.js",
    "js/stencils.min.js",
    "js/shapes-14-6-5.min.js",
    "js/PostConfig.js",
    "js/main.js",
    "mxgraph/css/common.css",
    "resources/dia.txt",
    "resources/dia_zh.txt",
    "styles/grapheditor.css",
    "styles/high-contrast.css",
  ]),
  localFiles: Object.freeze([
    "adapter.html",
    "adapter.js",
    "embed.html",
    "embed-config.js",
    "embed-bridge.js",
    ...CIRCUIT_RUNTIME_FILES,
    "patent-localization.js",
    "patent-toolbar.css",
    "resources/patent_zh.txt",
  ]),
});

const ALLOWED_STENCILS = new Set(
  DRAWIO_POLICY.libraries.map((library) => `stencils/${library}.xml`),
);
const ALLOWED_APP_FILES = new Set([...DRAWIO_POLICY.appFiles, ...DRAWIO_POLICY.localFiles]);
const REJECTED_SEGMENTS = new Set(["plugins", "connect", "integrations", "server", "cloud"]);
const REJECTED_STENCIL_NAMES =
  /(?:^|[-_])(aws|azure|gcp|google|oracle|ibm|salesforce|servicenow)(?:[-_.]|$)/iu;

/**
 * Classifies a path relative to the draw.io repository or to the vendored app root.
 * Only paths in the curated runtime allowlist are allowed into a production bundle.
 */
export function classifyDrawioPath(path) {
  if (typeof path !== "string" || !path.trim()) return "reject";
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const relative = normalized.startsWith(UPSTREAM_ROOT)
    ? normalized.slice(UPSTREAM_ROOT.length)
    : normalized;
  if (
    relative.includes("..") ||
    relative.split("/").some((segment) => REJECTED_SEGMENTS.has(segment.toLowerCase())) ||
    relative.endsWith(".map") ||
    /(?:^|\/)(?:aws|azure|gcp|google|oracle|ibm|salesforce|servicenow)(?:[-_.]|\/|$)/iu.test(
      relative,
    )
  ) {
    return "reject";
  }
  if (ALLOWED_APP_FILES.has(relative) || ALLOWED_STENCILS.has(relative)) return "allow";
  if (relative.startsWith("stencils/") && REJECTED_STENCIL_NAMES.test(relative)) return "reject";
  return "reject";
}

export function allowedUpstreamPaths() {
  return [...DRAWIO_POLICY.appFiles, ...ALLOWED_STENCILS].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

export function allowedAppPaths() {
  return [...allowedUpstreamPaths(), ...DRAWIO_POLICY.localFiles].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

import { describe, expect, it } from "vitest";

import { classifyDrawioPath, DRAWIO_POLICY } from "./drawio-bundle-policy.mjs";

describe("draw.io bundle policy", () => {
  it("pins the reviewed upstream revision and curated patent resources", () => {
    expect(DRAWIO_POLICY.upstream).toEqual({
      repository: "https://github.com/jgraph/drawio",
      tag: "v30.0.4",
      commit: "88ee1f5ab4d40603a8f3aaa0d9d6dc3794c6b3f0",
      license: "Apache-2.0",
    });
    expect(DRAWIO_POLICY.languages).toEqual(["zh", "en"]);
    expect(DRAWIO_POLICY.libraries).toEqual(["arrows", "basic", "bpmn", "flowchart"]);
  });

  it.each([
    ["src/main/webapp/index.html", "allow"],
    ["adapter.html", "allow"],
    ["adapter.js", "allow"],
    ["embed.html", "allow"],
    ["src/main/webapp/js/bootstrap.js", "allow"],
    ["src/main/webapp/js/PreConfig.js", "allow"],
    ["src/main/webapp/js/app.min.js", "allow"],
    ["src/main/webapp/js/extensions.min.js", "allow"],
    ["src/main/webapp/js/stencils.min.js", "allow"],
    ["src/main/webapp/js/shapes-14-6-5.min.js", "allow"],
    ["src/main/webapp/js/PostConfig.js", "allow"],
    ["src/main/webapp/js/main.js", "allow"],
    ["src/main/webapp/styles/grapheditor.css", "allow"],
    ["src/main/webapp/styles/high-contrast.css", "allow"],
    ["src/main/webapp/resources/dia_zh.txt", "allow"],
    ["src/main/webapp/resources/dia.txt", "allow"],
    ["resources/patent_zh.txt", "allow"],
    ["patent-localization.js", "allow"],
    ["patent-toolbar.css", "allow"],
    ["circuit-domain.js", "allow"],
    ["circuit-component-policy.js", "allow"],
    ["circuit-layout-core.js", "reject"],
    ["circuit-auto-layout.js", "reject"],
    ["src/main/webapp/plugins/sql.js", "reject"],
    ["src/main/webapp/connect/trello.js", "reject"],
    ["src/main/webapp/js/app.min.js.map", "reject"],
    ["src/main/webapp/stencils/aws4.xml", "reject"],
    ["src/main/webapp/stencils/azure.xml", "reject"],
  ])("classifies %s as %s", (path, expected) => {
    expect(classifyDrawioPath(path)).toBe(expected);
  });
});

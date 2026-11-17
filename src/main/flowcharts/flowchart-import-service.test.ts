import { deflateRawSync, deflateSync } from "node:zlib";
import { FLOWCHART_MAX_DECOMPRESSED_XML_BYTES } from "../../shared/flowcharts/limits.js";
import { type FlowchartImportError, FlowchartImportService } from "./flowchart-import-service.js";

const service = new FlowchartImportService();
const bytes = (value: string) => new TextEncoder().encode(value);

const compressedPage = (xml: string) =>
  `<mxfile><diagram id="p1">${deflateRawSync(encodeURIComponent(xml)).toString("base64")}</diagram></mxfile>`;

test("validates compressed drawio pages without changing their editable source", () => {
  const xml = compressedPage('<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>');
  const imported = service.parse({ name: "compressed.drawio", bytes: bytes(xml) });
  expect(imported).toMatchObject({ kind: "editable", pageCount: 1, lastPageId: "p1" });
  expect(new TextDecoder().decode(imported.source)).toBe(xml);
});

test.each([
  [
    compressedPage(
      '<mxGraphModel><root><mxCell id="0" style="image=https://remote.test/a.png"/></root></mxGraphModel>',
    ),
    "REMOTE_RESOURCE",
  ],
  [
    compressedPage("<mxGraphModel><root><script>alert(1)</script></root></mxGraphModel>"),
    "UNSAFE_XML",
  ],
  ['<mxfile><diagram id="p1"><mxGraphModel></diagram></mxfile>', "CORRUPT_FILE"],
  ['<mxfile><diagram id="p1">not-valid-base64</diagram></mxfile>', "CORRUPT_FILE"],
  [
    '<mxfile><diagram id="p1"><mxGraphModel/></diagram><diagram id="p1"><mxGraphModel/></diagram></mxfile>',
    "CORRUPT_FILE",
  ],
])("rejects invalid page contents before persisting them: %s", (xml, code) => {
  expect(() => service.parse({ name: "invalid.drawio", bytes: bytes(xml) })).toThrowError(
    expect.objectContaining({ code }),
  );
});

test("bounds decompression of a small compressed input", () => {
  const input = compressedPage(
    `<mxGraphModel>${"A".repeat(FLOWCHART_MAX_DECOMPRESSED_XML_BYTES)}</mxGraphModel>`,
  );
  expect(() => service.parse({ name: "oversized.drawio", bytes: bytes(input) })).toThrowError(
    expect.objectContaining({ code: "SOURCE_TOO_LARGE" }),
  );
});

test("imports editable drawio XML and reports its pages", () => {
  const result = service.parse({
    name: "control.drawio",
    bytes: bytes(
      '<mxfile><diagram id="p1" name="第一页"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram><diagram id="p2" name="第二页"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>',
    ),
  });
  expect(result).toMatchObject({
    name: "control",
    pageCount: 2,
    lastPageId: "p1",
    kind: "editable",
  });
});

test("extracts an embedded editable source from a drawio PNG", () => {
  const xml = '<mxfile><diagram id="p1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
  const keyword = Buffer.from("mxGraphModel\0", "latin1");
  const payload = Buffer.concat([keyword, Buffer.from([0]), deflateSync(Buffer.from(xml))]);
  const chunk = (type: string, data: Uint8Array) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.byteLength, 0);
    header.write(type, 4, "ascii");
    return Buffer.concat([header, Buffer.from(data), Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("zTXt", payload),
    chunk("IEND", new Uint8Array()),
  ]);

  const result = service.parse({ name: "embedded.png", bytes: png });

  expect(result).toMatchObject({ kind: "editable", pageCount: 1 });
  expect(new TextDecoder().decode(result.source)).toContain("<mxfile>");
});

test.each([
  ["icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'],
  ["icon.png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
])("wraps an ordinary %s as one flattened image object", (name, input) => {
  const result = service.parse({ name, bytes: typeof input === "string" ? bytes(input) : input });
  expect(result).toMatchObject({ kind: "flattened", pageCount: 1 });
  expect(new TextDecoder().decode(result.source)).toContain("shape=image");
});

test.each([
  [
    "unsafe.drawio",
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><mxfile>&e;</mxfile>',
    "UNSAFE_XML",
  ],
  [
    "remote.svg",
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a.png"/></svg>',
    "REMOTE_RESOURCE",
  ],
  ["wrong.png", "not a png", "MIME_MISMATCH"],
])("rejects unsafe or mismatched input %s with a stable code", (name, input, code) => {
  expect(() => service.parse({ name, bytes: bytes(input) })).toThrowError(
    expect.objectContaining<Partial<FlowchartImportError>>({
      code: code as FlowchartImportError["code"],
    }),
  );
});

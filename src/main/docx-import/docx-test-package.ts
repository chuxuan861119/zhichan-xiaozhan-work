import yazl from "yazl";

export type DocxTestEntry = readonly [name: string, bytes: Uint8Array | string];

export function createDocxTestPackage(
  entries: readonly DocxTestEntry[] = [],
  options: Readonly<{ includeDocument?: boolean }> = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    const defaults: DocxTestEntry[] = [
      [
        "[Content_Types].xml",
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ],
      ...(options.includeDocument === false
        ? []
        : ([
            ["word/document.xml", '<w:document xmlns:w="urn:w"><w:body/></w:document>'],
          ] satisfies DocxTestEntry[])),
    ];
    const suppliedNames = new Set(entries.map(([name]) => name));
    for (const [name, bytes] of [
      ...defaults.filter(([name]) => !suppliedNames.has(name)),
      ...entries,
    ]) {
      zip.addBuffer(
        typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes),
        name,
      );
    }
    zip.end();
  });
}

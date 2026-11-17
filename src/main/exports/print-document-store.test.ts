import { PrintDocumentStore } from "./print-document-store.js";

const TOKEN = "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41";

describe("private print document store", () => {
  test("serves a complete HTML document larger than 2 MiB behind a short one-time URL", () => {
    const store = new PrintDocumentStore({ createToken: () => TOKEN });
    const html = `<!doctype html><body>${"专利图".repeat(800_000)}</body>`;

    const lease = store.publish(html);

    expect(Buffer.byteLength(html, "utf8")).toBeGreaterThan(2 * 1024 * 1024);
    expect(lease.url).toBe(`patent-print://job/${TOKEN}`);
    expect(lease.url.length).toBeLessThan(100);
    expect(store.consume(lease.url)).toBe(html);
    expect(store.consume(lease.url)).toBeNull();
  });

  test("rejects oversized HTML and never resolves malformed or generic URLs", () => {
    const store = new PrintDocumentStore({ createToken: () => TOKEN, maxHtmlBytes: 16 });

    expect(() => store.publish("x".repeat(17))).toThrow("打印文档过大");
    const lease = store.publish("safe");
    expect(store.consume(`${lease.url}?path=C:/secret`)).toBeNull();
    expect(store.consume("patent-print://other/anything")).toBeNull();
    expect(store.consume(lease.url)).toBe("safe");
  });

  test("explicit disposal clears an unconsumed HTML job", () => {
    const store = new PrintDocumentStore({ createToken: () => TOKEN });
    const lease = store.publish("<p>unused</p>");

    lease.dispose();

    expect(store.consume(lease.url)).toBeNull();
  });
});

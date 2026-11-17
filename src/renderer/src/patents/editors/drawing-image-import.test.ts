import { readDrawingImageFiles } from "./drawing-image-import";

test("reads supported drawing image files and ignores unrelated files", async () => {
  const png = new File([Uint8Array.from([1, 2, 3])], "附图.png", { type: "image/png" });
  const jpeg = new File([Uint8Array.from([4, 5])], "附图.jpg", { type: "image/jpeg" });
  const text = new File(["not an image"], "说明.txt", { type: "text/plain" });

  await expect(readDrawingImageFiles([png, text, jpeg])).resolves.toEqual([
    {
      originalName: "附图.png",
      declaredMediaType: "image/png",
      bytes: Uint8Array.from([1, 2, 3]),
    },
    {
      originalName: "附图.jpg",
      declaredMediaType: "image/jpeg",
      bytes: Uint8Array.from([4, 5]),
    },
  ]);
});

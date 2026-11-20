import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processDesignImage } from "./image-processor.js";

describe("processDesignImage", () => {
  it("applies non-destructive trim, rotation and canvas normalization in sequence", async () => {
    const blackSquare = Buffer.alloc(10 * 10 * 4);
    for (let index = 3; index < blackSquare.length; index += 4) blackSquare[index] = 255;
    const source = await sharp({
      create: { width: 100, height: 80, channels: 4, background: "white" },
    })
      .composite([
        {
          input: blackSquare,
          raw: { width: 10, height: 10, channels: 4 },
          left: 20,
          top: 10,
        },
      ])
      .png()
      .toBuffer();

    const result = await processDesignImage(source, [
      { kind: "trim", left: 10, top: 5, width: 40, height: 30 },
      { kind: "rotate", degrees: 90 },
      { kind: "canvas", width: 80, height: 60, fit: "contain" },
    ]);

    expect(await sharp(result.bytes).metadata()).toMatchObject({
      width: 80,
      height: 60,
      format: "png",
    });
    expect(result).toMatchObject({ widthPx: 80, heightPx: 60 });
    expect(result.subjectBounds).toBeNull();
  });

  it("derives product-subject bounds from a non-white background without altering source pixels", async () => {
    const source = await sharp({
      create: { width: 30, height: 20, channels: 3, background: "white" },
    })
      .composite([
        {
          input: Buffer.alloc(10 * 6 * 3, 0),
          raw: { width: 10, height: 6, channels: 3 },
          left: 8,
          top: 5,
        },
      ])
      .png()
      .toBuffer();

    const result = await processDesignImage(source, []);

    expect(result.subjectBounds).toEqual({ leftPx: 8, topPx: 5, widthPx: 10, heightPx: 6 });
    expect(result).toMatchObject({ widthPx: 30, heightPx: 20 });
    expect(await sharp(result.bytes).metadata()).toMatchObject({
      width: 30,
      height: 20,
      format: "png",
    });
  });

  it("applies a replayable light perspective correction without changing the source asset", async () => {
    const source = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "white" },
    })
      .composite([
        {
          input: Buffer.alloc(20 * 10 * 3, 0),
          raw: { width: 20, height: 10, channels: 3 },
          left: 10,
          top: 10,
        },
      ])
      .png()
      .toBuffer();

    const result = await processDesignImage(source, [{ kind: "affine", xSkew: 0.08, ySkew: 0 }]);

    expect(result.widthPx).toBeGreaterThan(40);
    expect(result.subjectBounds).not.toBeNull();
    expect(await sharp(source).metadata()).toMatchObject({ width: 40, height: 30 });
  });

  it("rejects oversized source dimensions before rasterizing the full image", async () => {
    const oversizedSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10001" height="4001"></svg>',
    );

    await expect(processDesignImage(oversizedSvg, [])).rejects.toThrow(/safe processing limit/u);
  });

  it("accepts a common 24 MP photo source when safely downscaling the output", async () => {
    const photoSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="4000"><rect x="1000" y="1000" width="4000" height="2000" fill="black"/></svg>',
    );

    const result = await processDesignImage(photoSvg, [
      { kind: "canvas", width: 1200, height: 800, fit: "contain" },
    ]);

    expect(result).toMatchObject({ widthPx: 1200, heightPx: 800 });
    expect(result.subjectBounds).not.toBeNull();
  });

  it("rejects a transform whose estimated output would exceed the safe limit", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4600" height="4600"></svg>',
    );

    await expect(processDesignImage(source, [{ kind: "rotate", degrees: 45 }])).rejects.toThrow(
      /safe processing limit/u,
    );
  });
});

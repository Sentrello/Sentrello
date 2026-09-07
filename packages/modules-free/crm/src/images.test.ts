import { expect, test } from "bun:test";
import { processImage } from "@sentrello/module-sdk";
import sharp from "sharp";
import { MAX_IMAGE_BYTES } from "./images";

const jpeg = async (width: number, height: number) =>
  new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: "#c33" },
    })
      .jpeg()
      .toBuffer(),
  );

/**
 * The point of the whole thing: a photograph off a phone becomes something
 * small enough to draw in a list, without being squashed.
 */
test("a large photograph comes back small, as WebP, in proportion", async () => {
  const out = await processImage(await jpeg(4000, 3000));
  const meta = await sharp(out.bytes).metadata();

  expect(meta.format).toBe("webp");
  expect(out.width).toBe(512);
  // 4000x3000 is 4:3, so 512 wide is 384 tall. A square avatar box would have
  // been easier and would have squashed every landscape photo.
  expect(out.height).toBe(384);
  expect(out.bytes.byteLength).toBeLessThan(200 * 1024);
});

test("a picture already smaller than the box is not blown up", async () => {
  const out = await processImage(await jpeg(120, 90));
  expect(out.width).toBe(120);
  expect(out.height).toBe(90);
});

test("a portrait photograph keeps its shape too", async () => {
  const out = await processImage(await jpeg(1500, 3000));
  expect(out.height).toBe(512);
  expect(out.width).toBe(256);
});

/**
 * Re-encoding is the security boundary. Anything that is not really an image
 * fails to decode, and anything hidden after the image data does not survive
 * being turned back into pixels.
 */
test("a file pretending to be an image is refused", async () => {
  const html = new TextEncoder().encode(
    "<html><script>alert(document.cookie)</script></html>",
  );
  await expect(processImage(html)).rejects.toThrow(
    /does not look like an image/,
  );
});

test("an SVG is refused rather than rasterised", async () => {
  // A document format that can carry scripts and fetch external references.
  // Nobody uploads a vector as their avatar, and rasterising one means handing
  // an untrusted document to a parser with a history of surprises.
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>1</script></svg>',
  );
  await expect(processImage(svg)).rejects.toThrow(
    /cannot be used as a picture|does not look like an image/,
  );
});

test("a payload appended to a real image does not survive", async () => {
  const real = await jpeg(200, 200);
  const smuggled = new TextEncoder().encode("<script>alert(1)</script>");
  const joined = new Uint8Array(real.byteLength + smuggled.byteLength);
  joined.set(real);
  joined.set(smuggled, real.byteLength);

  const out = await processImage(joined);
  const text = new TextDecoder().decode(out.bytes);
  expect(text).not.toContain("<script>");
  expect((await sharp(out.bytes).metadata()).format).toBe("webp");
});

test("an empty file and an oversized one are both refused", async () => {
  await expect(processImage(new Uint8Array(0))).rejects.toThrow(/empty/);
  await expect(
    processImage(new Uint8Array(MAX_IMAGE_BYTES + 1)),
  ).rejects.toThrow(/under 5MB/);
});

/**
 * Turning what somebody uploaded into something safe to serve.
 *
 * Phones produce four-megapixel photographs and people upload them whole. What
 * arrives is never what is stored: every image is decoded, straightened,
 * scaled to fit and written as WebP.
 *
 * That re-encoding is also the security boundary, and the reason it happens
 * even for a file that is already a small WebP. A `.png` that is really HTML,
 * an SVG carrying a script, a JPEG with a payload after the end marker — none
 * of them survive being decoded to pixels and encoded again. The bytes we
 * serve are bytes this process produced.
 *
 * It lives in the SDK because it is not one module's problem. The CRM keeps
 * faces and logos; a shop keeps product photographs; the next module will keep
 * something else. Two copies of this is how one of them ends up without the
 * size check.
 */
import sharp from "sharp";

/**
 * Raster formats only, and deliberately not SVG.
 *
 * SVG is a document format that can carry scripts and external references, and
 * rasterising one means handing an untrusted document to a parser with a
 * history of surprises.
 */
const ACCEPTED = new Set(["jpeg", "jpg", "png", "webp", "gif", "avif", "heif"]);

export interface ImageRules {
  /** The longest edge of the stored image, in pixels. */
  maxEdge: number;
  /** The largest file that may be uploaded, before any of this happens. */
  maxBytes: number;
  /** WebP quality. 82 is where the difference stops being visible. */
  quality?: number;
}

/** An avatar or a logo: small, drawn at a couple of hundred pixels at most. */
export const AVATAR_RULES: ImageRules = {
  maxEdge: 512,
  maxBytes: 5 * 1024 * 1024,
};

/**
 * A product photograph, which somebody will want to look at closely.
 *
 * Wider than an avatar because a customer deciding whether to buy something
 * zooms in on it, and heavier on the way in because a product shot out of a
 * camera is bigger than a phone snap.
 */
export const PRODUCT_IMAGE_RULES: ImageRules = {
  maxEdge: 1600,
  maxBytes: 12 * 1024 * 1024,
};

export interface ProcessedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * Decode, straighten, shrink, re-encode.
 *
 * Takes bytes and returns bytes, with no database and no session anywhere near
 * it: this is where a bad file has to be rejected, and that is worth being
 * able to prove on its own.
 */
export async function processImage(
  input: Uint8Array,
  rules: ImageRules = AVATAR_RULES,
): Promise<ProcessedImage> {
  if (input.byteLength === 0) throw new RangeError("that file is empty");
  if (input.byteLength > rules.maxBytes) {
    throw new RangeError(
      `images must be under ${Math.floor(rules.maxBytes / 1024 / 1024)}MB`,
    );
  }

  let format: string | undefined;
  try {
    format = (await sharp(input).metadata()).format;
  } catch {
    throw new RangeError("that does not look like an image");
  }
  if (!format || !ACCEPTED.has(format)) {
    throw new RangeError(
      `${format ?? "that file"} cannot be used as a picture here`,
    );
  }

  const output = await sharp(input)
    // Phone cameras record orientation in EXIF rather than in the pixels. Skip
    // this and every photograph taken sideways is stored sideways.
    .rotate()
    .resize(rules.maxEdge, rules.maxEdge, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: rules.quality ?? 82 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: new Uint8Array(output.data),
    width: output.info.width,
    height: output.info.height,
  };
}

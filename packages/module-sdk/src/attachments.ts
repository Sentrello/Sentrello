import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

/**
 * Files hanging off a record, wherever they hang from.
 *
 * A quote on a note, a photograph on a job, a signed sheet on a booking. Every
 * module that keeps one has the same three problems, and the CRM had already
 * solved them once — so this is that solution moved to where the other modules
 * can reach it rather than copied into each of them, which is how one of them
 * ends up without the size check.
 *
 * The three, and none of them is housekeeping:
 *
 *  - **The stored name is generated**, never the one that was uploaded, so
 *    nothing a caller sends can climb out of the directory.
 *  - **Files come back as downloads with a neutral content type**, so an
 *    uploaded .html or .svg cannot execute against this origin as the
 *    signed-in user.
 *  - **Reading one requires permission on the record it hangs from**, since
 *    the files themselves have no owner of their own. That check belongs to
 *    the module and is the one thing this cannot do for it.
 */

/**
 * Ten megabytes.
 *
 * Large enough for a scanned quote or a phone photograph, small enough that a
 * business cannot fill its own disk by accident. nginx refuses larger bodies
 * before this is ever reached, so the two need to stay in step.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Where a module's files live, under the instance's data directory. */
export function attachmentsDir(folder = "attachments"): string {
  return join(resolve(process.env.SENTRELLO_DATA_DIR ?? "/data"), folder);
}

/**
 * The extension, if it is one we are prepared to write.
 *
 * Not a security control on its own — the content type on the way out is what
 * makes an uploaded file harmless. This only keeps the directory tidy and
 * stops a filename's own punctuation reaching the filesystem.
 */
export function safeExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/**
 * Shown to people; never used as a path.
 *
 * Control characters go, and a newline is the one that matters. This name is
 * whatever the uploader's own file was called, and on the CRM's public form
 * the uploader is anybody on the internet — so it ends up in a
 * `Content-Disposition` header, and a header value carrying a line break is
 * rejected outright by the runtime. Not an injection: Bun throws, which
 * means the attachment answers 500 for ever and the person who needed to
 * read the CV cannot. A file called `cv\r\n.pdf` was a small, permanent
 * denial of exactly one record, planted by whoever uploaded it.
 */
export function displayFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them
  const clean = base.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.slice(0, 120) || "file";
}

export interface StoredAttachment {
  name: string;
  /** Relative to the folder, and always inside it. */
  path: string;
  size: number;
  type: string;
}

/** A file rejected, and why, in words a person can act on. */
export class AttachmentError extends Error {}

/**
 * Takes a file, returns what to record about it.
 *
 * Scoped by organization on disk as well as in the row: two businesses on one
 * instance should not share a directory, and a path traversal that got past
 * everything else would still land inside one of them.
 */
export async function storeAttachment(
  orgId: string,
  file: File,
  folder = "attachments",
): Promise<StoredAttachment> {
  if (file.size === 0) throw new AttachmentError("that file is empty");
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError("that file is too large (10MB limit)");
  }

  const stored = `${crypto.randomUUID()}${safeExtension(file.name)}`;
  const dir = join(attachmentsDir(folder), orgId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, stored), Buffer.from(await file.arrayBuffer()), {
    mode: 0o600,
  });

  return {
    name: displayFilename(file.name),
    path: `${orgId}/${stored}`,
    size: file.size,
    type: file.type || "application/octet-stream",
  };
}

/**
 * The file behind a recorded path, or nothing.
 *
 * The path came out of a row this caller was allowed to read, but it is still
 * checked against the directory: a row is data, and data that has been edited
 * once is data that can be edited again.
 */
export function attachmentFile(
  path: string,
  folder = "attachments",
): ReturnType<typeof Bun.file> | null {
  const root = attachmentsDir(folder);
  const wanted = resolve(root, path);
  if (wanted !== root && !wanted.startsWith(root + sep)) return null;
  return Bun.file(wanted);
}

/** The headers that make a stored file harmless to hand back. */
/**
 * A `Content-Disposition` line for a name somebody else chose.
 *
 * Lifted out of the documents module, which had worked this out properly and
 * was the only place that had it — a paid module, so Core and the free ones
 * could not use the good version and had a weaker one of their own.
 *
 * Two names, because one cannot serve both ends. The quoted `filename` keeps
 * printable ASCII, which every client can read; `filename*` carries the real
 * one percent-encoded per RFC 5987, for the clients that read that. Without
 * the second, a CV called `Lebenslauf_Müller.pdf` arrives with its own name
 * mangled — in a product whose markets are the US, Canada, the UK and the EU.
 *
 * Control characters go from both. A header value carrying a line break is
 * refused by the runtime, so a file called `report\n.pdf` was not an
 * injection but a download that answered 500 for ever.
 */
export function contentDisposition(
  kind: "attachment" | "inline",
  name: string,
): string {
  const ascii =
    name
      .replace(/[^\x20-\x7e]+/g, " ")
      .replace(/["\\]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "file";
  const utf8 = encodeURIComponent(name.replace(/[\r\n]/g, " ")).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16)}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export function attachmentHeaders(name: string): Record<string, string> {
  return {
    // Neutral, always: an uploaded .html served as text/html runs as this
    // origin, with the reader's session.
    "content-type": "application/octet-stream",
    "content-disposition": contentDisposition("attachment", name),
    "content-security-policy": "default-src 'none'",
    "x-content-type-options": "nosniff",
  };
}

/** Removing one, when the record that held it is gone. */
export async function removeAttachment(
  path: string,
  folder = "attachments",
): Promise<void> {
  const file = attachmentFile(path, folder);
  if (!file) return;
  await unlink(file.name ?? "").catch(() => {});
}

/**
 * The folder a business's evidence lives in — a receipt on a transaction or
 * on a bill, whichever module the bill happens to be owned by. Both keep a
 * `<path>|<name>` column rather than a table of their own: a receipt belongs
 * to exactly one row and dies with it, and a table would be a second row to
 * keep in step for no question it answers. Shared here, not per-caller,
 * because a second copy of a string two files must agree on forever is worse
 * than one export.
 */
export const RECEIPTS_FOLDER = "receipts";

/** The stored path, and the name to hand it back under, packed into one string. */
export function packAttachmentKey(path: string, name: string): string {
  return `${path}|${name.replace(/\|/g, "-")}`;
}

export function unpackAttachmentKey(key: string): {
  path: string;
  name: string;
} {
  const bar = key.indexOf("|");
  return bar === -1
    ? { path: key, name: "receipt" }
    : { path: key.slice(0, bar), name: key.slice(bar + 1) };
}

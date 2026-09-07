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

/** Shown to people; never used as a path. */
export function displayFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  return base.slice(0, 120) || "file";
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
export function attachmentHeaders(name: string): Record<string, string> {
  return {
    // Neutral, always: an uploaded .html served as text/html runs as this
    // origin, with the reader's session.
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${name.replace(/["\\]/g, "")}"`,
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

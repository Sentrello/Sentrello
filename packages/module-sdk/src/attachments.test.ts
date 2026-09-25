import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttachmentError,
  attachmentFile,
  attachmentHeaders,
  displayFilename,
  packAttachmentKey,
  safeExtension,
  storeAttachment,
  unpackAttachmentKey,
} from "./attachments";

/**
 * Files are the part of a module that can hurt somebody: a name that climbs
 * out of a directory, or a stored .html served back as itself and running with
 * the reader's session.
 */

test("the name on disk is ours, whatever was uploaded", async () => {
  process.env.SENTRELLO_DATA_DIR = await mkdtemp(join(tmpdir(), "att-"));

  const stored = await storeAttachment(
    "org-1",
    new File(["a quote"], "../../etc/passwd", { type: "text/plain" }),
  );
  expect(stored.path.startsWith("org-1/")).toBe(true);
  expect(stored.path).not.toContain("..");
  // The person still sees what they called it.
  expect(stored.name).toBe("passwd");
});

test("an extension is kept only when it looks like one", () => {
  expect(safeExtension("quote.pdf")).toBe(".pdf");
  expect(safeExtension("photo.JPEG")).toBe(".jpeg");
  expect(safeExtension("archive.tar.gz")).toBe(".gz");
  expect(safeExtension("no-extension")).toBe("");
  expect(safeExtension("weird.<script>")).toBe("");
});

test("a filename shown to somebody is not a path", () => {
  expect(displayFilename("/etc/passwd")).toBe("passwd");
  expect(displayFilename("..\\\\windows\\\\system32\\\\x.dll")).toBe("x.dll");
  expect(displayFilename("")).toBe("file");
  expect(displayFilename("x".repeat(400)).length).toBe(120);
});

test("an empty or enormous file is refused with a reason", async () => {
  process.env.SENTRELLO_DATA_DIR = await mkdtemp(join(tmpdir(), "att-"));

  await expect(
    storeAttachment("org-1", new File([], "empty.pdf")),
  ).rejects.toBeInstanceOf(AttachmentError);

  const huge = new File([new Uint8Array(11 * 1024 * 1024)], "huge.bin");
  await expect(storeAttachment("org-1", huge)).rejects.toBeInstanceOf(
    AttachmentError,
  );
});

test("a path that climbs out of the directory reads nothing", async () => {
  process.env.SENTRELLO_DATA_DIR = await mkdtemp(join(tmpdir(), "att-"));
  expect(attachmentFile("../../etc/passwd")).toBeNull();
  expect(attachmentFile("org-1/../../../etc/passwd")).toBeNull();
  expect(attachmentFile("org-1/file.pdf")).not.toBeNull();
});

test("a stored path and name pack into one column and back out again", () => {
  const key = packAttachmentKey("org-1/abc123.pdf", "supplier invoice.pdf");
  expect(key).toBe("org-1/abc123.pdf|supplier invoice.pdf");
  expect(unpackAttachmentKey(key)).toEqual({
    path: "org-1/abc123.pdf",
    name: "supplier invoice.pdf",
  });
});

test("a name carrying the separator does not split the key", () => {
  const key = packAttachmentKey("org-1/x.pdf", "a|b|c.pdf");
  expect(unpackAttachmentKey(key)).toEqual({
    path: "org-1/x.pdf",
    name: "a-b-c.pdf",
  });
});

test("a key with no separator is a bare path, with a fallback name", () => {
  expect(unpackAttachmentKey("org-1/abc123.pdf")).toEqual({
    path: "org-1/abc123.pdf",
    name: "receipt",
  });
});

test("what comes back cannot execute against this origin", () => {
  const headers = attachmentHeaders('trouble".html');
  expect(headers["content-type"]).toBe("application/octet-stream");
  expect(headers["content-disposition"]).toContain("attachment;");
  // The quote in the name does not end the header's own quoting.
  expect(headers["content-disposition"]).toBe(
    'attachment; filename="trouble.html"',
  );
  expect(headers["x-content-type-options"]).toBe("nosniff");
});

/**
 * A filename from somebody who is not signed in.
 *
 * The CRM's form is embedded on a business's public website and takes files —
 * a CV, a photograph of a job — so the name on one is whatever a stranger's
 * computer called it. That name is shown to staff and put into a
 * `Content-Disposition` header, and a header value carrying a line break is
 * refused outright by the runtime: not an injection, a 500 on that one
 * attachment for ever, planted by whoever uploaded it.
 */
test("a filename cannot carry a line break out of the upload", () => {
  expect(displayFilename("cv\r\nX-Injected: 1.pdf")).toBe(
    "cv X-Injected: 1.pdf",
  );
  expect(displayFilename("quote\u0000.pdf")).toBe("quote .pdf");
});

test("the header it produces is one the runtime will accept", () => {
  const headers = attachmentHeaders('evil"\r\nX-Injected: 1.pdf');
  // The proof, rather than a regex: this is the thing that used to throw.
  expect(() => new Response("x", { headers })).not.toThrow();
  expect(headers["content-disposition"]).not.toContain("\n");
});

/** And an ordinary name is still itself. */
test("a name nobody was attacking is untouched", () => {
  expect(displayFilename("Quote for the Hendersons.pdf")).toBe(
    "Quote for the Hendersons.pdf",
  );
  expect(attachmentHeaders("Quote.pdf")["content-disposition"]).toBe(
    'attachment; filename="Quote.pdf"',
  );
});

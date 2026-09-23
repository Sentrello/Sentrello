import { connect } from "node:net";

/**
 * Checking a file somebody uploaded before it is kept.
 *
 * Every upload on this platform so far has come from a signed-in person with a
 * permission on the record they were attaching to. A public form is a
 * different proposition: the door is open to the internet, and whatever comes
 * through it gets written to the instance's own disk and later opened by
 * somebody in the business.
 *
 * Two checks, and they answer different questions.
 *
 *  - **What it is**, which is structural and always runs. A PDF that does not
 *    begin like a PDF is not one; a PDF carrying JavaScript, an embedded file
 *    or an action that fires on open is a PDF doing something a CV has no
 *    reason to do. This costs nothing and catches the shapes that matter.
 *  - **Whether it is known to be bad**, which needs a scanner with signatures
 *    and is therefore optional. Set `CLAMAV_HOST` and every file goes through
 *    it; leave it unset and nothing changes for an instance that does not want
 *    a second daemon.
 *
 * The structural check reads the bytes as they arrived. A PDF can hide its
 * innards inside compressed object streams, so a hostile file can keep the
 * words this looks for out of sight — which is the whole reason the scanner
 * exists as well, rather than instead.
 */

export interface FileVerdict {
  ok: boolean;
  /** Why it was refused, in words that can be shown to whoever sent it. */
  reason?: string;
}

const HEADER = "%PDF-";
/** How far in the header may sit. Readers tolerate a little leading rubbish. */
const HEADER_WINDOW = 1024;
/** How much of the tail to look in for the end marker. */
const TAIL_WINDOW = 4096;

/**
 * The things a document can carry that a document nobody asked for should not.
 *
 * Opening actions and embedded files are how a PDF does something other than
 * being read. None of them belongs in a CV, a quote or a photograph of a
 * meter, which is every file a form has a reason to collect.
 */
const FORBIDDEN: [RegExp, string][] = [
  [/\/JavaScript\b/, "it carries JavaScript"],
  [/\/JS\b/, "it carries JavaScript"],
  [/\/Launch\b/, "it can start another program"],
  [/\/EmbeddedFiles?\b/, "it has another file inside it"],
  [/\/OpenAction\b/, "it does something the moment it opens"],
  [/\/AA\b/, "it does something the moment it opens"],
  [/\/RichMedia\b/, "it carries embedded media"],
  [/\/XFA\b/, "it is a form built on a retired format"],
];

const latin1 = new TextDecoder("latin1");

/** Is this a PDF, and is it one that only sits there and be read? */
export function inspectPdf(bytes: Uint8Array): FileVerdict {
  if (bytes.byteLength === 0) return { ok: false, reason: "the file is empty" };

  const head = latin1.decode(bytes.subarray(0, HEADER_WINDOW));
  if (!head.includes(HEADER)) {
    return { ok: false, reason: "it is not a PDF" };
  }

  const tail = latin1.decode(
    bytes.subarray(Math.max(0, bytes.byteLength - TAIL_WINDOW)),
  );
  if (!tail.includes("%%EOF")) {
    return { ok: false, reason: "the PDF is incomplete" };
  }

  /*
   * Read as latin1, so every byte is one character and nothing is lost to a
   * decoder replacing a sequence it did not like — which is exactly how a
   * marker would slip past a check written against UTF-8.
   */
  const whole = latin1.decode(bytes);
  for (const [pattern, reason] of FORBIDDEN) {
    if (pattern.test(whole)) return { ok: false, reason };
  }

  return { ok: true };
}

export interface ScanResult {
  clean: boolean;
  /** What the scanner called it, when it called it something. */
  signature?: string;
}

/**
 * Hands the bytes to clamd and waits for its verdict.
 *
 * INSTREAM over a socket: the daemon takes the file in length-prefixed chunks
 * and answers in one line. Nothing is written to disk on the way, so a file
 * that turns out to be malware never existed as a file.
 *
 * Throws if the scanner cannot be reached. The caller decides what that means;
 * for a public form it means refusing the upload, because an instance that
 * asked for scanning did not ask for "unless the scanner is down".
 */
export async function scanForMalware(
  bytes: Uint8Array,
  host: string,
  port = 3310,
  timeoutMs = 30_000,
): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let reply = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error("the scanner did not answer"))),
    );
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8");
    });
    socket.on("close", () =>
      finish(() => {
        const line = reply.replace(/\0+$/, "").trim();
        if (!line) {
          reject(new Error("the scanner said nothing"));
          return;
        }
        if (/\bOK$/.test(line)) {
          resolve({ clean: true });
          return;
        }
        const found = /:\s*(.+?)\s+FOUND$/.exec(line);
        if (found) {
          resolve({ clean: false, signature: found[1] });
          return;
        }
        reject(new Error(line));
      }),
    );

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      // Chunked, because clamd has its own limit on a single write and a
      // whole CV in one go would sit right on it.
      const size = 64 * 1024;
      for (let at = 0; at < bytes.byteLength; at += size) {
        const slice = bytes.subarray(at, Math.min(at + size, bytes.byteLength));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(slice.byteLength, 0);
        socket.write(header);
        socket.write(Buffer.from(slice));
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

/** Where the scanner is, when an instance has chosen to run one. */
export function scannerAddress(): { host: string; port: number } | null {
  const host = process.env.CLAMAV_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  return { host, port: Number.isFinite(port) ? port : 3310 };
}

/**
 * The whole check, in the order that costs least.
 *
 * Structure first, because it needs nothing and refuses most of what will ever
 * be refused. The scanner second, and only if one is configured.
 */
export async function checkUpload(bytes: Uint8Array): Promise<FileVerdict> {
  const shape = inspectPdf(bytes);
  if (!shape.ok) return shape;

  const scanner = scannerAddress();
  if (!scanner) return { ok: true };

  try {
    const result = await scanForMalware(bytes, scanner.host, scanner.port);
    return result.clean
      ? { ok: true }
      : { ok: false, reason: "the file did not pass a malware scan" };
  } catch {
    // Fail closed. An instance that turned the scanner on wants files
    // scanned, and "the scanner is down" is not a reason to keep one anyway.
    return { ok: false, reason: "the file could not be checked right now" };
  }
}

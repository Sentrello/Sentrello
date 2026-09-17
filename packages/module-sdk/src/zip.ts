import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A zip file, written and read a member at a time.
 *
 * The archive a business takes off its server has to be readable in ten years
 * by somebody who no longer runs Sentrello, on whatever computer they have.
 * That rules out anything of ours. A zip is opened by double-clicking it on
 * every operating system a customer might have, with nothing installed — and
 * it carries a CRC-32 of every member in the format itself, so the container
 * corroborates the checksums our own manifest states rather than being the
 * only thing vouching for them.
 *
 * Hand-written rather than taken from a package, for two reasons that both
 * point the same way. This is the one feature whose failure destroys records,
 * and a dependency is a thing that changes under it; and the subset of the
 * format needed here is small enough to read in one sitting — no encryption,
 * no zip64, no multi-disk, no data descriptors.
 *
 * **Member at a time is the load-bearing part.** The instance this runs on may
 * have under a gigabyte of memory, and the whole point of the feature is that
 * it has years of rows. So a caller hands members in one by one and the writer
 * yields bytes as it goes; a reader is handed a stream and yields members as
 * they arrive. Nothing here ever holds the whole archive. Callers keep
 * individual members small — `archive.ts` caps them at a few thousand rows and
 * numbers the pieces — because both ends do hold one member at a time.
 *
 * No data descriptors is what makes the reader simple: every size and checksum
 * is in the local header, ahead of the bytes it describes, so a reader that can
 * only go forwards — which is what reading back from a remote destination is —
 * never has to seek to the end to learn what it is looking at.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
/** Bit 11: the name is UTF-8. Without it a member with an accent in its name
 *  opens under a different name on a Windows machine. */
const UTF8 = 0x800;
const DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipMember {
  /** The path inside the archive, e.g. `data/invoices-0001.jsonl`. */
  name: string;
  bytes: Uint8Array;
}

interface Entry {
  name: Uint8Array;
  crc: number;
  compressed: number;
  uncompressed: number;
  offset: number;
}

/**
 * The bytes of a zip holding whatever the caller yields, in order.
 *
 * `members` is an async iterable so the caller can read a table in pages and
 * hand over one page at a time; nothing is buffered here beyond the member in
 * hand and one small record per member for the central directory.
 */
export async function* writeZip(
  members: AsyncIterable<ZipMember> | Iterable<ZipMember>,
): AsyncGenerator<Uint8Array> {
  const entries: Entry[] = [];
  let offset = 0;

  for await (const member of members) {
    const name = new TextEncoder().encode(member.name);
    const body = deflateRawSync(member.bytes);
    const entry: Entry = {
      name,
      crc: crc32(member.bytes),
      compressed: body.length,
      uncompressed: member.bytes.length,
      offset,
    };
    entries.push(entry);

    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, UTF8, true);
    view.setUint16(8, DEFLATE, true);
    // A fixed timestamp, and deliberately so: two archives of the same rows
    // should have the same checksum, which is what lets an operator compare a
    // re-export against the manifest of the one they took away last year.
    view.setUint16(10, 0, true);
    view.setUint16(12, 0x21, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.compressed, true);
    view.setUint32(22, entry.uncompressed, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    header.set(name, 30);

    yield header;
    yield body;
    offset += header.length + body.length;
  }

  const start = offset;
  for (const entry of entries) {
    const header = new Uint8Array(46 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, CENTRAL, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, UTF8, true);
    view.setUint16(10, DEFLATE, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0x21, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.compressed, true);
    view.setUint32(24, entry.uncompressed, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint32(38, 0o644 << 16, true);
    view.setUint32(42, entry.offset, true);
    header.set(entry.name, 46);
    yield header;
    offset += header.length;
  }

  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, EOCD, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, offset - start, true);
  view.setUint32(16, start, true);
  yield end;
}

export class ZipError extends Error {}

/**
 * A queue that hands out exactly as many bytes as the reader asks for.
 *
 * The chunks arriving from a file or a network response have nothing to do
 * with where one member ends and the next begins, and a reader that assumed
 * otherwise would work on every archive small enough to arrive in one piece
 * and fail on the ones that matter.
 */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private size = 0;
  constructor(private source: AsyncIterator<Uint8Array>) {}

  /** Exactly `n` bytes, or null once the source is spent and short. */
  async take(n: number): Promise<Uint8Array | null> {
    while (this.size < n) {
      const next = await this.source.next();
      if (next.done) return null;
      const chunk =
        next.value instanceof Uint8Array
          ? next.value
          : new Uint8Array(next.value as ArrayBufferLike);
      if (chunk.length === 0) continue;
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0] as Uint8Array;
      const wanted = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, wanted), filled);
      filled += wanted;
      if (wanted === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(wanted);
      this.size -= wanted;
    }
    return out;
  }
}

/**
 * The members of a zip, in the order they were written.
 *
 * Forward-only, so it works the same against a file on disk and a response
 * body coming back from wherever the archive was sent. Stops at the central
 * directory: everything after it repeats what the local headers already said.
 */
export async function* readZip(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<ZipMember> {
  const iterator = (
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : (async function* () {
          for (const chunk of source as Iterable<Uint8Array>) yield chunk;
        })()
  ) as AsyncIterator<Uint8Array>;
  const queue = new ByteQueue(iterator);

  let seen = 0;
  for (;;) {
    const signatureBytes = await queue.take(4);
    if (!signatureBytes) {
      throw new ZipError(
        "the archive ends before its own directory — it is truncated",
      );
    }
    const signature = new DataView(
      signatureBytes.buffer,
      signatureBytes.byteOffset,
      4,
    ).getUint32(0, true);

    /**
     * The directory at the end, read rather than skipped.
     *
     * It repeats what the local headers already said, so nothing is taken from
     * it — but its count is the one statement in the file about how many
     * members there should be. Reading it is how an archive that was cut short
     * in transit is refused instead of quietly handing over the members that
     * did arrive.
     */
    if (signature === CENTRAL || signature === EOCD) {
      let declared = 0;
      let at = signature;
      for (;;) {
        if (at === EOCD) {
          const rest = await queue.take(18);
          if (!rest)
            throw new ZipError("the archive's end record is cut short");
          declared = new DataView(rest.buffer, rest.byteOffset, 18).getUint16(
            6,
            true,
          );
          break;
        }
        if (at !== CENTRAL)
          throw new ZipError("the archive's directory is damaged");
        const rest = await queue.take(42);
        if (!rest) throw new ZipError("the archive's directory is cut short");
        const view = new DataView(rest.buffer, rest.byteOffset, 42);
        const skip =
          view.getUint16(24, true) +
          view.getUint16(26, true) +
          view.getUint16(28, true);
        if (skip && !(await queue.take(skip))) {
          throw new ZipError("the archive's directory is cut short");
        }
        const next = await queue.take(4);
        if (!next)
          throw new ZipError("the archive has no end record — it is truncated");
        at = new DataView(next.buffer, next.byteOffset, 4).getUint32(0, true);
      }
      if (declared !== seen) {
        throw new ZipError(
          `the archive says it holds ${declared} members and ${seen} arrived`,
        );
      }
      return;
    }
    if (signature !== LOCAL) {
      throw new ZipError("this is not a zip file, or it is damaged");
    }

    const header = await queue.take(26);
    if (!header) throw new ZipError("a member's header is cut short");
    const view = new DataView(header.buffer, header.byteOffset, 26);
    const flags = view.getUint16(2, true);
    if (flags & 0x8) {
      // Nothing we write uses one, so a member with one came from elsewhere
      // and its sizes are not where this reader looks for them.
      throw new ZipError(
        "this archive uses data descriptors and cannot be read here",
      );
    }
    const method = view.getUint16(4, true);
    const crc = view.getUint32(10, true);
    const compressed = view.getUint32(14, true);
    const uncompressed = view.getUint32(18, true);
    const nameLength = view.getUint16(22, true);
    const extraLength = view.getUint16(24, true);

    const nameBytes = await queue.take(nameLength);
    if (!nameBytes) throw new ZipError("a member's name is cut short");
    if (extraLength && !(await queue.take(extraLength))) {
      throw new ZipError("a member's header is cut short");
    }
    const body = await queue.take(compressed);
    if (!body) throw new ZipError("a member's contents are cut short");

    let bytes: Uint8Array;
    if (method === 0) bytes = body;
    else if (method === DEFLATE) bytes = inflateRawSync(body);
    else
      throw new ZipError(
        `a member is compressed in a way we cannot read (${method})`,
      );

    // Checked here rather than left to the caller: a member that unpacks to
    // the wrong bytes must never reach code that is about to delete the
    // originals, whatever that code remembers to verify afterwards.
    if (bytes.length !== uncompressed || crc32(bytes) !== crc) {
      throw new ZipError(
        `${new TextDecoder().decode(nameBytes)} does not match its own checksum`,
      );
    }
    seen += 1;
    yield { name: new TextDecoder().decode(nameBytes), bytes };
  }
}

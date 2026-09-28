import { expect, test } from "bun:test";
import { ZipError, crc32, readZip, writeZip } from "./zip";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

test("what goes in comes out, byte for byte", async () => {
  const members = [
    { name: "manifest.json", bytes: encode('{"period":"2019"}') },
    {
      name: "data/invoices-0001.jsonl",
      bytes: encode('{"id":"a"}\n{"id":"b"}\n'),
    },
    // Repetitive, so it actually exercises the compressed path rather than
    // accidentally storing everything.
    {
      name: "data/record_events-0001.jsonl",
      bytes: encode("x".repeat(50_000)),
    },
  ];
  const zip = await collect(writeZip(members));

  const out: Record<string, string> = {};
  for await (const member of readZip([zip]))
    out[member.name] = decode(member.bytes);

  expect(Object.keys(out)).toEqual(members.map((m) => m.name));
  expect(out["manifest.json"]).toBe('{"period":"2019"}');
  expect(out["data/invoices-0001.jsonl"]).toBe('{"id":"a"}\n{"id":"b"}\n');
  expect(out["data/record_events-0001.jsonl"]).toBe("x".repeat(50_000));
  // It compressed: fifty thousand identical bytes in well under a kilobyte.
  expect(zip.length).toBeLessThan(2_000);
});

test("it reads the same when the bytes arrive in awkward pieces", async () => {
  const zip = await collect(
    writeZip([{ name: "a.jsonl", bytes: encode("line\n".repeat(400)) }]),
  );
  // Seven-byte chunks cut through every header in the file, which is exactly
  // what a network read does and what a reader that assumed whole headers
  // would fail on.
  async function* dribble() {
    for (let at = 0; at < zip.length; at += 7) yield zip.subarray(at, at + 7);
  }
  const members = [];
  for await (const member of readZip(dribble())) members.push(member);
  expect(members).toHaveLength(1);
  expect(decode(members[0]?.bytes as Uint8Array)).toBe("line\n".repeat(400));
});

test("a damaged member is refused, not handed over", async () => {
  const zip = await collect(
    writeZip([{ name: "a.jsonl", bytes: encode("the original rows") }]),
  );
  // Flip a byte in the compressed body, past the 30-byte header and the name.
  const damaged = new Uint8Array(zip);
  const at = 30 + "a.jsonl".length + 2;
  damaged[at] = (damaged[at] as number) ^ 0xff;

  const read = async () => {
    for await (const _ of readZip([damaged])) {
      /* nothing should be yielded */
    }
  };
  expect(read()).rejects.toThrow();
});

test("a truncated archive is refused rather than silently short", async () => {
  const zip = await collect(
    writeZip([
      { name: "a.jsonl", bytes: encode("first") },
      { name: "b.jsonl", bytes: encode("second") },
    ]),
  );
  const read = async () => {
    for await (const _ of readZip([zip.subarray(0, zip.length - 60)])) {
      /* keep reading */
    }
  };
  expect(read()).rejects.toBeInstanceOf(ZipError);
});

test("something that is not a zip says so", async () => {
  const read = async () => {
    for await (const _ of readZip([
      encode("this is a text file, not an archive at all"),
    ])) {
      /* nothing */
    }
  };
  expect(read()).rejects.toThrow(/not a zip/);
});

test("crc32 matches the published check value", () => {
  // The standard "123456789" vector, so a rewritten table is caught here
  // rather than by a zip tool refusing a customer's archive years later.
  expect(crc32(encode("123456789"))).toBe(0xcbf43926);
});

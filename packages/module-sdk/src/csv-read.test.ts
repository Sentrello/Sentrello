import { expect, test } from "bun:test";
import { toCsv } from "./csv";
import { csvRows, decodeSpreadsheet } from "./csv-read";

// A quote inside a field is an inch mark. Treated as the start of quoting, it
// swallowed the next row and its amount with it.
test("a quote inside a field does not swallow the next row", () => {
  expect(csvRows('a,b\n5" screen,2\n7" tablet,3\n')).toEqual([
    ["a", "b"],
    ['5" screen', "2"],
    ['7" tablet', "3"],
  ]);
});

test("a lone carriage return ends a row", () => {
  expect(csvRows("a,b\rc,d")).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
});

// Our own export guards these; read back, they kept the apostrophe.
test("an export survives its own import", () => {
  const out = toCsv(
    ["name", "phone"],
    [
      ["-Ann", "+44 1248 555 0123"],
      ["=SUM(A1)", "-12.50"],
    ],
  );
  expect(csvRows(out).slice(1)).toEqual([
    ["-Ann", "+44 1248 555 0123"],
    ["=SUM(A1)", "-12.50"],
  ]);
});

test("a spreadsheet saved as UTF-16 or Windows-1252 reads as written", () => {
  const utf16 = new Uint8Array([
    0xff,
    0xfe,
    ...[..."Name"].flatMap((c) => [c.charCodeAt(0), 0]),
  ]);
  expect(decodeSpreadsheet(utf16)).toBe("Name");
  // "Müller £5 €5" in Windows-1252.
  const cp1252 = new Uint8Array([
    0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x20, 0xa3, 0x35, 0x20, 0x80, 0x35,
  ]);
  expect(decodeSpreadsheet(cp1252)).toBe("Müller £5 €5");
  expect(decodeSpreadsheet(new TextEncoder().encode("Müller"))).toBe("Müller");
});

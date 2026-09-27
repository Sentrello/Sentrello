import { expect, test } from "bun:test";
import { guessMapping, parseCsv } from "./csv";

test("a plain sheet reads as rows", () => {
  const s = parseCsv("First name,Last name\nAda,Lovelace\nAlan,Turing\n");
  expect(s.headers).toEqual(["First name", "Last name"]);
  expect(s.rows).toEqual([
    ["Ada", "Lovelace"],
    ["Alan", "Turing"],
  ]);
});

/**
 * The case that silently corrupts an import: a field containing a comma. Split
 * naively, every column after it shifts and the phone number lands in the
 * email column.
 */
test("a quoted field keeps its commas", () => {
  const s = parseCsv('Name,Note\nOsei,"Called, no answer"\n');
  expect(s.rows).toEqual([["Osei", "Called, no answer"]]);
});

test("doubled quotes inside a quoted field are one quote", () => {
  const s = parseCsv('Name,Note\nKav,"Said ""next week"""\n');
  expect(s.rows[0]?.[1]).toBe('Said "next week"');
});

test("a line break inside a quoted field does not end the row", () => {
  // Addresses do this constantly.
  const s = parseCsv('Name,Address\nAchebe,"12 Mill Lane\nPortland"\n');
  expect(s.rows).toHaveLength(1);
  expect(s.rows[0]?.[1]).toBe("12 Mill Lane\nPortland");
});

test("CRLF files read the same as LF ones", () => {
  const s = parseCsv("A,B\r\n1,2\r\n");
  expect(s.rows).toEqual([["1", "2"]]);
});

/**
 * Excel writes a byte-order mark. Left in, the first column is named
 * "﻿First name" and no mapping will ever match it.
 */
test("a byte-order mark does not become part of the first column name", () => {
  const s = parseCsv("﻿First name,Last name\nAda,Lovelace\n");
  expect(s.headers[0]).toBe("First name");
});

test("a trailing newline does not add an empty contact", () => {
  expect(parseCsv("A\nx\n").rows).toEqual([["x"]]);
});

test("a short row is padded rather than dropped", () => {
  // A sheet whose last column is empty often omits it; dropping those rows
  // would lose people without saying so.
  const s = parseCsv("A,B,C\n1,2\n");
  expect(s.rows).toEqual([["1", "2", ""]]);
});

test("columns are guessed however they were spelled", () => {
  const fields = [
    { key: "firstName", label: "First name", aliases: ["given name"] },
    { key: "email", label: "Email", aliases: ["email address"] },
  ];
  expect(guessMapping(["Given Name", "E-mail Address"], fields)).toEqual({
    firstName: "Given Name",
    email: "E-mail Address",
  });
});

test("one column is not claimed by two fields", () => {
  const fields = [
    { key: "email", label: "Email" },
    { key: "other", label: "Email", aliases: ["email"] },
  ];
  const m = guessMapping(["Email"], fields);
  expect(m.email).toBe("Email");
  expect(m.other).toBeUndefined();
});

/**
 * Excel writes a semicolon wherever the comma is the decimal separator, which
 * is most of the EU — and the EU is a market. Read as commas, the whole sheet
 * is one column: the mapping screen offers `Vorname;Nachname;E-Mail` as a
 * single heading and the import writes contacts named after the entire row.
 */
test("a sheet Excel saved in Germany reads as columns", () => {
  const s = parseCsv(
    "Vorname;Nachname;E-Mail\nAnna;Schmidt;anna@example.test\n",
  );
  expect(s.headers).toEqual(["Vorname", "Nachname", "E-Mail"]);
  expect(s.rows).toEqual([["Anna", "Schmidt", "anna@example.test"]]);
});

test("a tab-separated sheet reads as columns", () => {
  const s = parseCsv("Name\tEmail\nAda\tada@example.test\n");
  expect(s.headers).toEqual(["Name", "Email"]);
  expect(s.rows).toEqual([["Ada", "ada@example.test"]]);
});

/**
 * The separator is decided from the heading line and outside quotes, so a
 * note full of semicolons cannot outvote the headings that came before it.
 */
test("a comma sheet whose notes are full of semicolons is still a comma sheet", () => {
  const s = parseCsv('Name,Note\nOsei,"rang; left a message; rang again"\n');
  expect(s.headers).toEqual(["Name", "Note"]);
  expect(s.rows).toEqual([["Osei", "rang; left a message; rang again"]]);
});

test("one column and no separator at all is still one column", () => {
  const s = parseCsv("Email\nada@example.test\n");
  expect(s.headers).toEqual(["Email"]);
  expect(s.rows).toEqual([["ada@example.test"]]);
});

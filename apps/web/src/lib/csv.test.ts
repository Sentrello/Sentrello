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

import { expect, test } from "bun:test";
import { EXPORT_COLUMNS } from "@sentrello/module-crm";
import { FIELDS } from "../routes/contacts-import";
import { guessMapping, parseCsv } from "./csv";

/**
 * Export, edit in a spreadsheet, import back.
 *
 * That is the loop people actually use — and it only works if the headers the
 * export writes are ones the import recognises. The two lists live in
 * different packages, so nothing but a test connects them.
 */
test("a file this app exported maps back onto itself", () => {
  const mapping = guessMapping([...EXPORT_COLUMNS], FIELDS);
  // A single "Name" column is how other systems export; ours writes first and
  // last, so that one field is for their files and has nothing to map to here.
  for (const field of FIELDS.filter((f) => f.key !== "fullName")) {
    expect({ field: field.key, mapped: mapping[field.key] }).toEqual({
      field: field.key,
      mapped: field.label,
    });
  }
  // And it must not swallow either half of a name our own file has.
  expect(mapping.fullName).toBeUndefined();
});

test("the commas and quotes a spreadsheet writes survive", () => {
  const sheet = parseCsv(
    'First name,Last name,Email\nNell,"Quist, Jr.",nell@x.test\n"Ana Maria",Ferreira-Lopes,ana@x.test\nPrince,,prince@x.test\n',
  );
  expect(sheet.headers).toEqual(["First name", "Last name", "Email"]);
  // A comma inside quotes is part of the name, not a new column.
  expect(sheet.rows[0]).toEqual(["Nell", "Quist, Jr.", "nell@x.test"]);
  expect(sheet.rows[1]).toEqual(["Ana Maria", "Ferreira-Lopes", "ana@x.test"]);
  // One name and no surname is a person, not a broken row.
  expect(sheet.rows[2]).toEqual(["Prince", "", "prince@x.test"]);
});

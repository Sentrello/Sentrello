import { expect, test } from "bun:test";
import {
  type CustomField,
  coerceCustomValues,
  fieldId,
  parseCustomFields,
} from "./custom-fields";

/**
 * A custom field is a schema a business writes at runtime, which makes the
 * validation the whole feature: without it the request body decides what a
 * record holds, and every key any caller sends is stored for ever.
 */

const fields: CustomField[] = [
  {
    id: "boiler_model",
    label: "Boiler model",
    type: "text",
    appliesTo: "contact",
  },
  { id: "units", label: "Units", type: "number", appliesTo: "contact" },
  {
    id: "surveyed_on",
    label: "Surveyed on",
    type: "date",
    appliesTo: "contact",
  },
  {
    id: "access",
    label: "Site access",
    type: "select",
    options: ["Key safe", "Tenant lets us in"],
    appliesTo: "contact",
  },
  { id: "vip", label: "VIP", type: "checkbox", appliesTo: "contact" },
  { id: "framework", label: "Framework", type: "text", appliesTo: "company" },
];

test("a value with no field behind it is dropped", () => {
  const stored = coerceCustomValues(fields, "contact", {
    boiler_model: "Worcester 4000",
    organizationId: "someone-elses",
    isAdmin: true,
  });
  expect(stored).toEqual({ boiler_model: "Worcester 4000" });
});

test("a field belongs to one kind of record", () => {
  // "Framework" is a company field; writing it onto a contact would put a
  // value in a place no form will ever show it again.
  expect(
    coerceCustomValues(fields, "contact", { framework: "G-Cloud" }),
  ).toEqual({});
  expect(
    coerceCustomValues(fields, "company", { framework: "G-Cloud" }),
  ).toEqual({ framework: "G-Cloud" });
});

test("each value is what its field says it is", () => {
  expect(
    coerceCustomValues(fields, "contact", {
      units: "12",
      vip: "true",
      surveyed_on: "2026-04-05T09:00:00Z",
    }),
  ).toEqual({ units: 12, vip: true, surveyed_on: "2026-04-05" });

  // "about thirty" in a number field would come back as NaN and take every
  // total that touched it with it.
  expect(
    coerceCustomValues(fields, "contact", { units: "about thirty" }),
  ).toEqual({});
  expect(
    coerceCustomValues(fields, "contact", { surveyed_on: "soon" }),
  ).toEqual({});
});

test("a list only accepts what is on the list", () => {
  expect(coerceCustomValues(fields, "contact", { access: "Key safe" })).toEqual(
    {
      access: "Key safe",
    },
  );
  expect(
    coerceCustomValues(fields, "contact", { access: "Through the window" }),
  ).toEqual({});
});

test("clearing a field stores nothing rather than the word nothing", () => {
  expect(
    coerceCustomValues(fields, "contact", { boiler_model: "", units: null }),
  ).toEqual({ boiler_model: null, units: null });
});

test("a field absent from the body is left alone", () => {
  // A form that predates a field must not wipe it.
  expect(coerceCustomValues(fields, "contact", { units: 3 })).toEqual({
    units: 3,
  });
});

test("definitions are refused rather than repaired", () => {
  expect(() =>
    parseCustomFields([{ label: "", type: "text", appliesTo: "contact" }]),
  ).toThrow();
  expect(() =>
    parseCustomFields([
      { label: "Colour", type: "rainbow", appliesTo: "contact" },
    ]),
  ).toThrow();
  expect(() =>
    parseCustomFields([
      { label: "Colour", type: "text", appliesTo: "invoice" },
    ]),
  ).toThrow();
  // A list with nothing to choose is a field nobody can fill in.
  expect(() =>
    parseCustomFields([
      { label: "Access", type: "select", options: [], appliesTo: "contact" },
    ]),
  ).toThrow();
  // Two fields with one id would overwrite each other on the record.
  expect(() =>
    parseCustomFields([
      { label: "Boiler model", type: "text", appliesTo: "contact" },
      { label: "boiler  model", type: "text", appliesTo: "contact" },
    ]),
  ).toThrow();
});

test("an id is derived from the label and stays a usable key", () => {
  expect(fieldId("Boiler model")).toBe("boiler_model");
  expect(fieldId("  Site access!  ")).toBe("site_access");
  expect(fieldId("Ünïcödé")).toBe("n_c_d");
});

test("the same label on two kinds of record is fine", () => {
  const parsed = parseCustomFields([
    { label: "Reference", type: "text", appliesTo: "contact" },
    { label: "Reference", type: "text", appliesTo: "company" },
  ]);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]?.id).toBe("reference");
});

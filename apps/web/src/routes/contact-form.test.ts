import { expect, test } from "bun:test";
import { nameBoxes } from "./contact-form";

/**
 * A contact you cannot edit is worse than one with a field missing.
 *
 * Found by human testing: opening a contact for editing showed two empty name
 * boxes and a Save button that stayed disabled no matter what else was
 * changed — including the status, which was the only thing being changed.
 *
 * The cause is that `firstName` and `lastName` are not always set. A contact
 * can arrive from a website form, a CSV import or a plain API call carrying
 * only `name`, and Save is guarded on one of the two parts being present. Six
 * of the eighteen contacts on the demo were in exactly that state and none of
 * them could be edited at all.
 */

test("a contact with both parts uses them as they are", () => {
  expect(
    nameBoxes({ firstName: "Ada", lastName: "Lovelace", name: "Ada Lovelace" }),
  ).toEqual({ firstName: "Ada", lastName: "Lovelace" });
});

test("a contact with only a display name is split into the boxes", () => {
  // The case that could not be edited.
  expect(
    nameBoxes({ firstName: null, lastName: null, name: "Grace Hopper" }),
  ).toEqual({ firstName: "Grace", lastName: "Hopper" });
});

test("a surname of several words stays whole", () => {
  // "van der Berg" is a surname, not three of them.
  expect(
    nameBoxes({ firstName: null, lastName: null, name: "Ana van der Berg" }),
  ).toEqual({ firstName: "Ana", lastName: "van der Berg" });
});

test("one word is a first name, not a surname", () => {
  expect(nameBoxes({ firstName: null, lastName: null, name: "Cher" })).toEqual({
    firstName: "Cher",
    lastName: "",
  });
});

test("half a name is left alone rather than reconstructed", () => {
  // Somebody deliberately recorded a surname and no forename. Splitting the
  // display name over the top of that would overwrite a real decision.
  expect(
    nameBoxes({ firstName: null, lastName: "Achterberg", name: "Achterberg" }),
  ).toEqual({ firstName: "", lastName: "Achterberg" });
});

test("a business with nothing to split gives empty boxes", () => {
  expect(nameBoxes({ firstName: null, lastName: null, name: "" })).toEqual({
    firstName: "",
    lastName: "",
  });
  expect(nameBoxes({ firstName: null, lastName: null, name: "   " })).toEqual({
    firstName: "",
    lastName: "",
  });
});

test("creating a contact starts with empty boxes", () => {
  expect(nameBoxes(undefined)).toEqual({ firstName: "", lastName: "" });
});

import { expect, test } from "bun:test";
import { changedFields } from "./record-events";

/**
 * Which fields moved, which is the whole difference between a rule that is
 * useful and a rule that fires on every save.
 *
 * "When the stage becomes won" and "when the stage is won" are different
 * questions. The second is true every time anything else on the deal is edited
 * afterwards — the address, a note, a phone number — so an automation written
 * that way sends a customer the same email once a week for ever.
 */

test("a field that did not move is not reported as moved", () => {
  const before = { name: "Acme", stage: "proposal", value: 1200 };
  const after = { name: "Acme", stage: "won", value: 1200 };
  expect(changedFields(before, after)).toEqual(["stage"]);
});

test("a field that appears counts, and so does one that goes", () => {
  expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
  expect(changedFields({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
});

/**
 * Compared by their JSON rather than by identity.
 *
 * Two dates for the same moment are different objects, and so are two
 * addresses with the same contents. Comparing them by reference reports every
 * date and every jsonb column as changed on every save, which makes "narrow
 * this rule to one field" useless exactly where records are richest.
 */
test("two equal dates are not a change", () => {
  const when = "2026-09-11T10:00:00.000Z";
  expect(
    changedFields({ closeOn: new Date(when) }, { closeOn: new Date(when) }),
  ).toEqual([]);
});

test("a nested object is compared by what is in it", () => {
  expect(
    changedFields(
      { address: { city: "Leeds", postcode: "LS1" } },
      { address: { city: "Leeds", postcode: "LS1" } },
    ),
  ).toEqual([]);
  expect(
    changedFields(
      { address: { city: "Leeds" } },
      { address: { city: "York" } },
    ),
  ).toEqual(["address"]);
});

/**
 * A record that was created or deleted has no other side to compare against.
 *
 * Reporting every field as changed would be defensible and useless: a rule
 * narrowed to "when the stage changes" would fire on every new deal, because
 * every deal is created with a stage.
 */
test("a creation and a deletion name no changed fields", () => {
  expect(changedFields(null, { stage: "lead" })).toEqual([]);
  expect(changedFields({ stage: "lead" }, null)).toEqual([]);
});

test("the list is in a stable order, so two runs agree", () => {
  expect(changedFields({ b: 1, a: 1 }, { b: 2, a: 2 })).toEqual(["a", "b"]);
});

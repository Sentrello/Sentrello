import { expect, test } from "bun:test";
import { findBorrowedIterator } from "./borrowed-iterator";

/**
 * The scanner itself, against the line that shipped and the four that are fine.
 *
 * The four safe borrowings matter more than the broken one here. Every one of
 * them is onto something array-like, all four were in the repositories on the
 * day the bug was written, and a check that failed on them would have been
 * turned off within an hour.
 */

test("the line that posted an empty body", () => {
  const found = findBorrowedIterator(`
    var data = new FormData(form);
    var body = Array.prototype.reduce.call(data.entries(), function (acc, pair) {
      acc[pair[0]] = pair[1];
      return acc;
    }, {});
  `);
  expect(found).toHaveLength(1);
  expect(found[0]?.method).toBe("reduce");
  expect(found[0]?.say).toContain("Object.fromEntries");
});

test("its argument a few lines down, which is where biome puts it", () => {
  const found = findBorrowedIterator(`
    const body = Array.prototype.reduce.call(
      params.entries(),
      (acc, pair) => acc,
      {},
    );
  `);
  expect(found).toHaveLength(1);
});

/**
 * Array-likes, which is nearly every borrowing anybody writes.
 *
 * A form's `elements`, an HTMLCollection, a NodeList. All have `length`, so the
 * borrowed method reads them perfectly, and all three of these are real lines
 * from the newsletter embed, the documentation theme script and the
 * accessibility walk.
 */
test("nothing is said about an array-like", () => {
  expect(
    findBorrowedIterator(`
      Array.prototype.forEach.call(el.elements, function (f) {
        if (f.name) body[f.name] = f.value;
      });
      var all = Array.prototype.slice.call(doc.querySelectorAll(selector));
      Array.prototype.forEach.call(category.parentElement.children, mark);
      var at = Array.prototype.indexOf.call(document.querySelectorAll("*"), el);
    `),
  ).toEqual([]);
});

/**
 * A `.values()` on an array is array-like and reads as an iterator here.
 *
 * It is: `[].values()` returns an Array Iterator with no `length`, the same as
 * a FormData's. The scan reads the call, not the receiver, and that is right —
 * `rows.values()` borrowed onto is broken whatever `rows` is.
 */
test("an array's own iterator counts too", () => {
  expect(
    findBorrowedIterator("Array.prototype.map.call(rows.values(), f);"),
  ).toHaveLength(1);
});

/** The file that explains the bug is not the file that has it. */
test("a comment describing it is not an instance of it", () => {
  expect(
    findBorrowedIterator(`
      // Array.prototype.reduce.call(data.entries(), …) posts an empty object.
      /* Array.prototype.reduce.call(map.keys(), …) does the same. */
    `),
  ).toEqual([]);
});

/** And a deliberate one, said out loud, with a reason. */
test("a borrowing excused in writing is left alone", () => {
  expect(
    findBorrowedIterator(`
      // borrowed-on-purpose: this iterator is a polyfill with a length on it.
      Array.prototype.slice.call(shim.values());
    `),
  ).toEqual([]);
  // The excuse has to say something.
  expect(
    findBorrowedIterator(`
      // borrowed-on-purpose:
      Array.prototype.slice.call(shim.values());
    `),
  ).toHaveLength(1);
});

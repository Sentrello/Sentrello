import { afterEach, expect, test } from "bun:test";
import {
  addSearchProvider,
  clearSearchProviders,
  scoreFor,
  searchEverything,
} from "@sentrello/module-sdk";

/**
 * One box that asks every module what it can find.
 *
 * The mechanism rather than any particular module's answers: that permission is
 * checked before a provider runs, that one module failing does not lose the
 * rest, and that the order is the same across modules — a shop's products and a
 * contact competing on the same footing is the whole point of it being one box.
 */

afterEach(() => clearSearchProviders());

const always = () => true;

function provider(
  kind: string,
  titles: string[],
  requires?: Record<string, string[]>,
) {
  addSearchProvider({
    requires,
    find: async ({ q }) =>
      titles
        .filter((title) => title.toLowerCase().includes(q.toLowerCase()))
        .map((title) => ({
          kind,
          title,
          opens: { moduleId: kind.toLowerCase() },
          score: scoreFor(q, title),
        })),
  });
}

test("one search asks every module and returns one list", async () => {
  provider("Contact", ["Ruth Adeyemi"]);
  provider("Product", ["Ruth's favourite mug"]);

  const hits = await searchEverything({
    organizationId: "org",
    q: "ruth",
    may: always,
  });
  expect(hits.map((hit) => hit.kind).sort()).toEqual(["Contact", "Product"]);
});

/**
 * Checked before the provider runs, not after.
 *
 * Filtering results afterwards means the rows were read, and the reason
 * somebody may not see the customer book is usually that they are a contractor
 * with access to one job.
 */
test("a provider nobody may use is never asked", async () => {
  let asked = false;
  addSearchProvider({
    requires: { crm: ["read"] },
    find: async () => {
      asked = true;
      return [{ kind: "Contact", title: "Ruth", opens: { moduleId: "c" } }];
    },
  });

  const hits = await searchEverything({
    organizationId: "org",
    q: "ruth",
    may: (requires) => !requires,
  });

  expect(hits).toEqual([]);
  expect(asked).toBe(false);
});

/**
 * A search that returns nothing because one module was slow or wrong is a
 * search nobody trusts, and the one thing worse than not finding something is
 * not finding it silently.
 */
test("one module failing does not lose the others", async () => {
  addSearchProvider({
    find: async () => {
      throw new Error("that query was nonsense");
    },
  });
  provider("Contact", ["Ruth Adeyemi"]);

  const hits = await searchEverything({
    organizationId: "org",
    q: "ruth",
    may: always,
  });
  expect(hits).toHaveLength(1);
});

test("the best match comes first, whichever module it came from", async () => {
  provider("Deal", ["Something mentioning Ruth in passing"]);
  provider("Contact", ["Ruth"]);

  const hits = await searchEverything({
    organizationId: "org",
    q: "ruth",
    may: always,
  });
  expect(hits[0]?.kind).toBe("Contact");
});

/**
 * Two letters, because one is every record in the business and a box that
 * searches everything on the first keystroke is a box that searches everything
 * on the first keystroke.
 */
test("a single letter finds nothing rather than everything", async () => {
  provider("Contact", ["Ruth Adeyemi"]);
  expect(
    await searchEverything({ organizationId: "org", q: "r", may: always }),
  ).toEqual([]);
  expect(
    await searchEverything({ organizationId: "org", q: "  ", may: always }),
  ).toEqual([]);
});

test("ranking puts a whole match above a start above a fragment", () => {
  expect(scoreFor("ruth", "Ruth")).toBe(1);
  expect(scoreFor("ruth", "Ruth Adeyemi")).toBe(0.8);
  expect(scoreFor("ruth", "Ask Ruth about it")).toBe(0.6);
  expect(scoreFor("ruth", "Nothing like it")).toBe(0.4);
});

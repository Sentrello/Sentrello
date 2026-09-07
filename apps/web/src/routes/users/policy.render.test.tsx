import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CarriedBy, Members } from "./policy";

/**
 * The Members and Groups tabs, actually rendered — the empty state each one
 * has to get right, which is also the ordinary one: most of a business's own
 * policies are held through a group rather than directly, and most groups
 * carry only a handful of the policies that exist. Ruling 43, the same
 * reasoning as `access-matrix.render.test.tsx`: a rule can be correct while
 * the markup around it draws nothing where it should draw a reason.
 */

test("nobody holding a policy directly says so, not an empty panel", () => {
  const html = renderToStaticMarkup(<Members members={[]} />);
  expect(html).toContain("Nobody holds this directly");
  expect(html).toContain("a group");
});

test("somebody holding it directly is listed by name, or by email without one", () => {
  const html = renderToStaticMarkup(
    <Members
      members={[
        { userId: "1", name: "Ada Lovelace", email: "ada@example.com" },
        { userId: "2", name: "", email: "noname@example.com" },
      ]}
    />,
  );
  expect(html).toContain("Ada Lovelace");
  expect(html).toContain("noname@example.com");
  expect(html).not.toContain("Nobody holds this directly");
});

test("no group carrying a policy says so, not an empty panel", () => {
  const html = renderToStaticMarkup(<CarriedBy groups={[]} />);
  expect(html).toContain("No group carries this");
});

test("every carrying group is named", () => {
  const html = renderToStaticMarkup(
    <CarriedBy
      groups={[
        { id: "1", name: "Accounting" },
        { id: "2", name: "The office" },
      ]}
    />,
  );
  expect(html).toContain("Accounting");
  expect(html).toContain("The office");
  expect(html).not.toContain("No group carries this");
});

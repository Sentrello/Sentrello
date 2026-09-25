import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { type Meta, useCan } from "./api";

/**
 * What a screen is told about what this person may do.
 *
 * The rule worth pinning is the fallback, not the happy path: **unknown means
 * allowed**. The set arrives with the shell's own meta query, so a screen can
 * render before it lands, a person may belong to no organization yet, and a
 * module can name a resource the server has not compiled. In every one of
 * those the answer is yes, because hiding a control from somebody entitled to
 * it is the worse of the two mistakes and the route refuses what it must
 * regardless.
 */
function answers(can: Meta["can"] | undefined, asks: [string, string][]) {
  const qc = new QueryClient();
  if (can !== undefined) {
    qc.setQueryData(["meta"], { nav: [], loaded: [], modules: [], can });
  }
  let said: boolean[] = [];
  function Probe() {
    const may = useCan();
    said = asks.map(([resource, action]) => may(resource, action));
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
  return said;
}

test("an action the person holds is allowed, one they do not is refused", () => {
  expect(
    answers({ crm: ["read", "create"] }, [
      ["crm", "read"],
      ["crm", "create"],
      ["crm", "delete"],
    ]),
  ).toEqual([true, true, false]);
});

test("a resource nobody has said anything about is allowed", () => {
  // The whole set missing: the shell's query has not answered yet.
  expect(answers(undefined, [["crm", "delete"]])).toEqual([true]);
  // The set is there and says nothing about this resource: a module naming
  // one the server has not compiled, which must not black out its own screen.
  expect(answers({ crm: ["read"] }, [["shop", "create"]])).toEqual([true]);
  // An empty set is the same case, and is what somebody who belongs to no
  // organization yet is sent.
  expect(answers({}, [["crm", "delete"]])).toEqual([true]);
});

/**
 * An empty list for a resource is a real answer and not a missing one: it
 * says this person holds nothing here. Read as "unknown" it would hand every
 * control back to exactly the people a policy was written to keep out.
 */
test("a resource listed with no actions refuses all of them", () => {
  expect(
    answers({ crm: [] }, [
      ["crm", "read"],
      ["crm", "delete"],
    ]),
  ).toEqual([false, false]);
});

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unregisteredRequests } from "./unregistered";

const dir = mkdtempSync(join(tmpdir(), "unregistered-"));
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

/**
 * The same hole as the one in `reachability.test.ts`, in the other direction.
 *
 * This check had its own copy of the comparison, so a screen asking
 * `` `/api/${holder}/${id}/receipt` `` — `api/*​/*​/receipt` — counted as
 * answered by any four-segment route whose tail was parameters, here an OAuth
 * callback in an unrelated module. A button that answers 404 came back clean,
 * and the report said so rather than saying nothing.
 */
test("an unrelated route with a parameter tail does not answer a request", () => {
  const route = write(
    "callback-route.ts",
    `app.delete("/api/payments/:provider/:mode", (c) => c.json({ ok: true }));`,
  );
  const screen = write(
    "receipt.tsx",
    `function Receipt({ holder, id }) {
       return api(\`/api/\${holder}/\${id}/receipt\`, { method: "DELETE" });
     }`,
  );

  expect(
    unregisteredRequests({ routeFiles: [route], screenFiles: [screen] }),
  ).toEqual(["DELETE api/*/*/receipt"]);
});

test("the route a screen actually asks for answers it", () => {
  const route = write(
    "receipt-route.ts",
    `app.delete("/api/transactions/:id/receipt", (c) => c.json({ ok: true }));`,
  );
  const screen = write(
    "money.tsx",
    `function Receipt({ id }) {
       return api(\`/api/transactions/\${id}/receipt\`, { method: "DELETE" });
     }`,
  );

  expect(
    unregisteredRequests({ routeFiles: [route], screenFiles: [screen] }),
  ).toEqual([]);
});

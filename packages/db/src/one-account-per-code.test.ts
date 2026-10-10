import { afterAll, expect, test } from "bun:test";
import { db, schema } from "./client";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * Two accounts with one code in one business split the postings meant for
 * one ledger line between them. A lock in ensureAccount stops two being made
 * at once; this asks the database to refuse it too.
 */
const orgs: string[] = [];
afterAll(async () => {
  for (const id of orgs) await dropOrganization(id);
});

test("a business cannot hold two accounts with one code", async () => {
  const orgId = await makeOrganization(
    `one-code-${crypto.randomUUID().slice(0, 8)}`,
  );
  orgs.push(orgId);
  const row = {
    organizationId: orgId,
    code: "4999",
    name: "Other income",
    type: "income",
  };
  await db.insert(schema.accounts).values(row);
  // Drizzle wraps the database's refusal; the constraint is on the cause.
  const refused = await db
    .insert(schema.accounts)
    .values(row)
    .then(() => null)
    .catch((err: { cause?: unknown }) => String(err.cause ?? err));
  expect(refused).toMatch(/accounts_org_code_uidx/);
});

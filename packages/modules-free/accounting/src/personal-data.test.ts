import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import {
  type RegisteredPersonalData,
  personalDataSources,
  registerForTest,
} from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * The contractor tax details source used to live in this Free package's own
 * `personal-data.ts` and query `contractorTaxDetails` directly — a Pro-only
 * table. It is now registered by `contractors.ts`, the file that owns the
 * table, so the Free half never names it.
 *
 * These are the tests that matter: a subject-access or erasure request must
 * still work correctly regardless of which file owns the registration, and
 * the registration must never quietly vanish.
 */

const suffix = crypto.randomUUID().slice(0, 8);
let freeOrgId: string;
let proOrgId: string;
let freeContactId: string;
let headers: Headers;

const source = () => personalDataSources().find((s) => s.id === "accounting");

/**
 * The closure a Free-entitled boot actually registered.
 *
 * Registration is keyed by id and the Free and Pro bodies below both boot
 * the same module under the same id, `"accounting"` — the second `register`
 * call replaces the first in the shared registry. Without capturing this
 * here, `source()` in a "Free instance" test would find whatever was
 * registered *last* (the Pro boot), not what a Free boot actually put there;
 * it would still pass, but for the wrong reason — proving "this closure
 * doesn't branch on entitlement" rather than "a Free instance's own
 * registration is safe to query." Captured for real so the test title is
 * true of what it checks.
 */
let freeSource: RegisteredPersonalData | undefined;

beforeAll(async () => {
  // Registered so a Free instance's own boot (nav, permissions, and this
  // source's registration) runs without error.
  registerForTest(accounting, undefined, () => false);
  freeSource = source();
  const pro = registerForTest(accounting, undefined, () => true);

  const signUp = await signUpAsOwner({
    email: `personal-data-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const freeOrg = await auth.api.createOrganization({
    body: { name: `Free ${suffix}`, slug: `pd-free-${suffix}` },
    headers,
  });
  if (!freeOrg) throw new Error("could not create the free organization");
  freeOrgId = freeOrg.id;

  const proOrg = await auth.api.createOrganization({
    body: { name: `Pro ${suffix}`, slug: `pd-pro-${suffix}` },
    headers,
  });
  if (!proOrg) throw new Error("could not create the pro organization");
  proOrgId = proOrg.id;

  await auth.api.setActiveOrganization({
    body: { organizationId: proOrgId },
    headers,
  });

  // Write a real contractor row through the Pro-entitled app, the only way
  // this table is ever written in production.
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: proOrgId, name: "Sam the joiner" })
    .returning();
  if (!contact) throw new Error("the contact was not written");

  const saved = await pro.request(
    `http://localhost/api/contractors/${contact.id}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        legalName: "Samuel Carpenter",
        entityType: "sole-proprietor",
        taxId: "123-45-6789",
        addressLine1: "1 High Street",
        city: "Leeds",
        region: "NY",
        postalCode: "10001",
      }),
    },
  );
  if (saved.status !== 200) {
    throw new Error(`could not save contractor details: ${saved.status}`);
  }

  // A contact in the free organisation, which could never have a contractor
  // row: the route that writes one 404s there.
  const [freeContact] = await db
    .insert(schema.contacts)
    .values({ organizationId: freeOrgId, name: "Someone else" })
    .returning();
  if (!freeContact) throw new Error("the free contact was not written");
  freeContactId = freeContact.id;
});

afterAll(async () => {
  for (const orgId of [freeOrgId, proOrgId]) {
    await db
      .delete(schema.contractorTaxDetails)
      .where(eq(schema.contractorTaxDetails.organizationId, orgId));
    await db
      .delete(schema.contacts)
      .where(eq(schema.contacts.organizationId, orgId));
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, orgId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
  }
});

test("the Free package no longer names the Pro-only contractor table", () => {
  const path = join(import.meta.dir, "personal-data.ts");
  // Either the file is gone entirely, or — if it still exists for some other
  // reason — it must not reference the table it never should have queried.
  if (!existsSync(path)) return;
  expect(readFileSync(path, "utf8")).not.toContain("contractorTaxDetails");
});

test("a subject-access request on a Free instance does not error, and finds nothing to report", async () => {
  // The source captured from the Free-entitled boot itself, not whichever
  // registration happens to be live right now — see the comment on
  // `freeSource` above.
  const registered = freeSource;
  expect(registered).toBeDefined();

  const records = await registered?.export(freeOrgId, { id: freeContactId });
  expect(records).toEqual([]);
});

test("a subject-access request on a Pro instance still includes contractor tax details", async () => {
  const registered = source();
  expect(registered).toBeDefined();

  const [contact] = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(eq(schema.contacts.organizationId, proOrgId));
  if (!contact) throw new Error("no contact to look up");

  const records = await registered?.export(proOrgId, { id: contact.id });
  expect(records).toHaveLength(1);
  expect(records?.[0]?.kind).toBe("Contractor tax details");
  expect(records?.[0]?.data.legalName).toBe("Samuel Carpenter");
  // Sealed everywhere else in the platform; an access request does not
  // re-expose it either.
  expect(records?.[0]?.data.taxId).toBe(
    "held, not shown — ask if they need it",
  );
});

test("an erasure request on a Pro instance still accounts for contractor tax details, kept rather than silently missing", () => {
  const registered = source();
  expect(registered).toBeDefined();

  // No `erase`: the retention obligation is the business's own and cannot be
  // waived by the person asking. What matters for compliance is that the
  // source is registered at all — so the erasure sweep in
  // `@sentrello/module-settings`'s /api/privacy/erase reports it as kept,
  // with a reason, rather than never mentioning it.
  expect(registered?.erase).toBeUndefined();
  expect(registered?.label).toBe("Contractor tax details");
  expect(registered?.retention.length).toBeGreaterThan(0);
});

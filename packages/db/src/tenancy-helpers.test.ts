import { afterAll, expect, test } from "bun:test";
import { db, schema } from "./client";
import { consentHistory, recordConsent } from "./consent";
import { eq, inArray } from "./orm";
import { activePaymentAccount } from "./payments";

/**
 * Shared helpers that take an `organizationId` and are trusted to use it.
 *
 * These are the ones no sweep can reach. `module-tenancy.test.ts` finds a leak
 * by calling a route; `query-scoping.test.ts` finds an unscoped read by
 * watching the SQL a route runs. Both need a route, and these functions are
 * called from write paths and from jobs — `activePaymentAccount` before a Pay
 * Now button is drawn, `consentHistory` when somebody asks what a business
 * holds about them.
 *
 * Measured on 2026-09-10: both keep their `organizationId` filter with the
 * whole suite green, which is to say nothing held them. They are the last two
 * of forty-four files in that state that can be covered without inventing a
 * route to reach them.
 *
 * Two businesses, each with its own row, and each must be handed its own.
 * A single-business database cannot tell the difference — which is the whole
 * reason this is written down rather than assumed.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const alpha = `alpha-${suffix}`;
const beta = `beta-${suffix}`;

afterAll(async () => {
  await db
    .delete(schema.consentRecords)
    .where(inArray(schema.consentRecords.organizationId, [alpha, beta]));
  await db
    .delete(schema.paymentAccounts)
    .where(inArray(schema.paymentAccounts.organizationId, [alpha, beta]));
});

test("a business is handed its own payment account, not another's", async () => {
  // Only the second business has one, which is the case that matters: the
  // first must be told "none", not handed somebody else's processor.
  await db.insert(schema.paymentAccounts).values({
    organizationId: beta,
    provider: "stripe",
    mode: "test",
    enabled: true,
  });

  expect(await activePaymentAccount(alpha)).toBeNull();

  const theirs = await activePaymentAccount(beta);
  expect(theirs?.organizationId).toBe(beta);

  // And with both holding one, each is given the one it owns rather than
  // whichever the database returned first.
  await db.insert(schema.paymentAccounts).values({
    organizationId: alpha,
    provider: "stripe",
    mode: "test",
    enabled: true,
  });
  expect((await activePaymentAccount(alpha))?.organizationId).toBe(alpha);
  expect((await activePaymentAccount(beta))?.organizationId).toBe(beta);
});

test("consent history is one business's record of one person", async () => {
  /*
   * The same subject id in both businesses, deliberately.
   *
   * A contact id is unique, so an unscoped read would usually return nothing
   * and look correct. What it must not do is answer for a subject both
   * businesses know — and "we hold consent for this person" is exactly the
   * sentence a regulator asks a business to stand behind.
   */
  const subject = { kind: "contact" as const, id: crypto.randomUUID() };

  await recordConsent({
    organizationId: alpha,
    subject,
    purpose: "marketing.email" as const,
    granted: true,
    source: "form",
  });
  await recordConsent({
    organizationId: beta,
    subject,
    purpose: "marketing.email" as const,
    granted: false,
    source: "form",
  });

  const mine = await consentHistory(alpha, subject);
  expect(mine.map((row) => row.organizationId)).toEqual([alpha]);
  expect(mine[0]?.granted).toBe(true);

  const theirs = await consentHistory(beta, subject);
  expect(theirs.map((row) => row.organizationId)).toEqual([beta]);
  expect(theirs[0]?.granted).toBe(false);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { db } from "./client";
import { creditBalanceFor, recordCreditMovement } from "./customer-credit";
import {
  CORE_ACCOUNTS,
  PeriodClosedError,
  ensureAccount,
  postJournalEntry,
} from "./ledger";
import { and, eq, inArray } from "./orm";
import * as schema from "./schema";

/**
 * A customer's credit and the posting that explains it, together or not at all.
 *
 * `customerCredits` is the subsidiary ledger behind one account: it says which
 * customer the liability on the balance sheet is held for. The two are one
 * fact recorded twice, and until now the helper that writes the row could not
 * join the transaction that writes the entry — so a caller that wanted them
 * atomic had to write the insert out by hand, and two of them had.
 *
 * What is proved here is the property that makes the seam worth having: when
 * the posting is refused, the row is not there either.
 */

let orgId: string;
let contactId: string;
let cashId: string;
let creditsId: string;

const IN_THE_PAST = new Date(Date.UTC(2024, 2, 15, 12));

beforeAll(async () => {
  orgId = crypto.randomUUID();
  await db.insert(schema.organizations).values({
    id: orgId,
    name: `credit-tx-${orgId}`,
    slug: `credit-tx-${orgId}`,
    createdAt: new Date(),
  });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Overpaying Customer" })
    .returning();
  if (!contact) throw new Error("could not create the contact");
  contactId = contact.id;

  cashId = await ensureAccount(orgId, CORE_ACCOUNTS.cash);
  creditsId = await ensureAccount(orgId, CORE_ACCOUNTS.customerCredits);
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const ids = entries.map((e) => e.id);
  if (ids.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, ids));
    await db
      .delete(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, orgId));
  }
  for (const table of [
    schema.customerCredits,
    schema.ledgerSettings,
    schema.accounts,
    schema.contacts,
  ]) {
    await db.delete(table).where(eq(table.organizationId, orgId));
  }
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

const closeThrough = async (day: Date | null) => {
  const [existing] = await db
    .select({ organizationId: schema.ledgerSettings.organizationId })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId))
    .limit(1);
  if (existing) {
    await db
      .update(schema.ledgerSettings)
      .set({ closedThrough: day })
      .where(eq(schema.ledgerSettings.organizationId, orgId));
    return;
  }
  await db
    .insert(schema.ledgerSettings)
    .values({ organizationId: orgId, closedThrough: day });
};

/** Grant a credit and post the liability that explains it, as one event. */
const grant = (cents: number, reason: string) =>
  db.transaction(async (tx) => {
    await recordCreditMovement(
      { organizationId: orgId, contactId, cents, reason },
      { tx },
    );
    await postJournalEntry(
      orgId,
      reason,
      "test",
      [
        { accountId: cashId, debitCents: cents },
        { accountId: creditsId, creditCents: cents },
      ],
      IN_THE_PAST,
      { tx },
    );
  });

const movements = () =>
  db
    .select()
    .from(schema.customerCredits)
    .where(
      and(
        eq(schema.customerCredits.organizationId, orgId),
        eq(schema.customerCredits.contactId, contactId),
      ),
    );

test("a credit refused by the closed books is not left behind on its own", async () => {
  await closeThrough(new Date(Date.UTC(2024, 11, 31)));

  await expect(grant(4_500, "Overpayment in a closed month")).rejects.toThrow(
    PeriodClosedError,
  );

  // The row went in first and the posting threw after it. Without the seam
  // this helper had no way into that transaction, so the row would have been
  // committed on its own — a customer holding credit the books never heard of.
  expect(await movements()).toHaveLength(0);
  expect(await creditBalanceFor(orgId, contactId)).toBe(0);
});

test("and with the books open, both are there", async () => {
  await closeThrough(null);

  await grant(4_500, "Overpayment on an invoice");

  const rows = await movements();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.cents).toBe(4_500);
  expect(await creditBalanceFor(orgId, contactId)).toBe(4_500);

  const [posted] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.memo, "Overpayment on an invoice"),
      ),
    );
  expect(posted).toBeDefined();
});

test("spending it is the same movement with the other sign", async () => {
  await db.transaction(async (tx) => {
    await recordCreditMovement(
      {
        organizationId: orgId,
        contactId,
        cents: -1_500,
        reason: "Applied to a later invoice",
      },
      { tx },
    );
    await postJournalEntry(
      orgId,
      "Credit applied",
      "test",
      [
        { accountId: creditsId, debitCents: 1_500 },
        { accountId: cashId, creditCents: 1_500 },
      ],
      IN_THE_PAST,
      { tx },
    );
  });
  expect(await creditBalanceFor(orgId, contactId)).toBe(3_000);
});

/**
 * And a caller with nothing open still gets a commit of its own, because the
 * option is an option: the shape `postJournalEntry` already took, so the two
 * halves of one event are written the same way.
 */
test("no transaction handed in means a commit of its own", async () => {
  await recordCreditMovement({
    organizationId: orgId,
    contactId,
    cents: 250,
    reason: "A goodwill credit",
  });
  expect(await creditBalanceFor(orgId, contactId)).toBe(3_250);
});

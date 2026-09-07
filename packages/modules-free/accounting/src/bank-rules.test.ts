import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { ruleMatches } from "./bank-rules";
import accounting from "./index";

/**
 * The only thing on the platform that writes to the ledger unattended.
 *
 * A rule turns "this statement line says Acme Fuel" into a posted journal
 * entry with nobody watching, which is what makes it the feature a bookkeeper
 * actually wants and the one most able to do damage quietly. Everything below
 * is a boundary on that: what it may look at, which way round it posts, and
 * how somebody gets out of it when the rule was wrong.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let bank = "";
let fuel = "";
let sales = "";
let importId = "";

type BankRuleRow = typeof schema.bankRules.$inferSelect;

/**
 * The second business, remembered rather than tidied where it is made.
 *
 * An organization left behind is not an untidy row: the sign-in log resolves
 * an attempt against an unknown address to the oldest organization there is,
 * so a leftover from here becomes the one another module's tests write their
 * events against and then cannot find.
 */
let otherOrgId: string | null = null;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

async function account(code: string, name: string, type: string) {
  const res = await post("/api/accounts", { code, name, type });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

/** A statement line, straight into the table the importer writes. */
async function line(
  description: string,
  amountCents: number,
  extra: Partial<typeof schema.bankTransactions.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.bankTransactions)
    .values({
      organizationId: orgId,
      importId,
      date: new Date("2026-08-15T00:00:00Z"),
      description,
      amountCents,
      bankAccountId: bank,
      ...extra,
    })
    .returning();
  if (!row) throw new Error("the statement line was not written");
  return row;
}

async function rule(body: Record<string, unknown>) {
  const res = await post("/api/bank-rules", {
    name: "Fuel",
    matchText: "acme fuel",
    accountId: fuel,
    ...body,
  });
  const { rule: made } = (await res.json()) as { rule: { id: string } };
  return made;
}

/** What a line ended up posted against, or nothing. */
async function postedAgainst(id: string) {
  const [row] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, id))
    .limit(1);
  if (!row?.matchedEntryId) return null;
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, row.matchedEntryId));
  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, row.matchedEntryId))
    .limit(1);
  return { entry, lines };
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `rules-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Rules ${suffix}`, slug: `rules-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  bank = await account("1000", "Current account", "asset");
  await db
    .update(schema.accounts)
    .set({ isBank: true })
    .where(eq(schema.accounts.id, bank));
  fuel = await account("6100", "Fuel", "expense");
  sales = await account("4000", "Sales", "income");

  const [batch] = await db
    .insert(schema.bankImports)
    .values({ organizationId: orgId, filename: "statement.csv" })
    .returning();
  if (!batch) throw new Error("the statement was not created");
  importId = batch.id;
});

afterAll(async () => {
  await scrub(orgId);
  if (otherOrgId) await scrub(otherOrgId);
});

async function scrub(id: string) {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, id));
  for (const entry of entries) {
    await db
      .delete(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
  }
  for (const t of [
    schema.bankTransactions,
    schema.bankImports,
    schema.bankRules,
    schema.journalEntries,
    schema.accounts,
    schema.securityEvents,
    schema.ledgerSettings,
  ]) {
    await db.delete(t).where(eq(t.organizationId, id));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, id));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
}

/**
 * Money out is an expense leaving the bank, and money in is not.
 *
 * The direction decides which side of the entry each account is on, and
 * getting it backwards produces an entry that balances perfectly and says the
 * opposite of what happened — the class of error nothing downstream can catch,
 * because the books add up.
 */
test("money out debits the account and credits the bank", async () => {
  const row = await line("ACME FUEL #4471", -4_250);
  await rule({});
  const run = await post("/api/bank-rules/apply", {});
  expect(run.status).toBe(200);
  expect(((await run.json()) as { applied: number }).applied).toBe(1);

  const posted = await postedAgainst(row.id);
  const byAccount = new Map(posted?.lines.map((l) => [l.accountId, l]));
  expect(byAccount.get(fuel)?.debitCents).toBe(4_250);
  expect(byAccount.get(bank)?.creditCents).toBe(4_250);
  expect(byAccount.get(fuel)?.creditCents).toBe(0);

  // And it says which rule did it, which is what makes a wrong one findable.
  expect(posted?.entry?.source).toStartWith("bank-rule:");

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

test("money in debits the bank and credits the account", async () => {
  const row = await line("STRIPE PAYOUT", 12_000);
  await rule({ name: "Payouts", matchText: "stripe", accountId: sales });
  await post("/api/bank-rules/apply", {});

  const posted = await postedAgainst(row.id);
  const byAccount = new Map(posted?.lines.map((l) => [l.accountId, l]));
  expect(byAccount.get(bank)?.debitCents).toBe(12_000);
  expect(byAccount.get(sales)?.creditCents).toBe(12_000);

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

/**
 * The two lines a rule must never touch.
 *
 * A reconciled line is somebody's own work and posting over it would double
 * the money. A pending line is a figure the bank has not committed to, and the
 * amount can still change under an entry already posted against it.
 */
test("a reconciled line and a pending line are both left alone", async () => {
  const reconciled = await line("ACME FUEL settled", -1_000, {
    matchedEntryId: crypto.randomUUID(),
  });
  const pending = await line("ACME FUEL pending", -2_000, { pending: true });
  await rule({});

  const run = await post("/api/bank-rules/apply", {});
  expect(((await run.json()) as { applied: number }).applied).toBe(0);

  const [stillPending] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, pending.id))
    .limit(1);
  expect(stillPending?.matchedEntryId).toBeNull();

  const [untouched] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, reconciled.id))
    .limit(1);
  // Exactly as it was: not repointed at a new entry of the rule's own.
  expect(untouched?.matchedEntryId).toBe(reconciled.matchedEntryId);

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

/**
 * The bounds are on the size, not on the number.
 *
 * Money out is negative here, so a rule reading "up to fifty dollars" written
 * against the raw figure means "anything below minus fifty dollars" — and
 * matches every large payment it was written to exclude while ignoring the
 * small ones it was written for.
 */
test("an amount limit means the size of the payment", async () => {
  const small = await line("ACME FUEL small", -1_000);
  const large = await line("ACME FUEL large", -90_000);
  await rule({ maxCents: 5_000 });

  await post("/api/bank-rules/apply", {});
  expect(await postedAgainst(small.id)).not.toBeNull();
  expect(await postedAgainst(large.id)).toBeNull();

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

test("a rule set to money in ignores money going out", async () => {
  const out = await line("TRANSFER acme savings", -30_000);
  await rule({
    name: "From savings",
    matchText: "acme savings",
    direction: "in",
  });

  await post("/api/bank-rules/apply", {});
  expect(await postedAgainst(out.id)).toBeNull();

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

/**
 * The first rule that matches, in the order the business set.
 *
 * Two rules that both fit is not an error to refuse; it is a business saying
 * which it prefers. Without an order the winner is whatever the database
 * returned first, which changes.
 */
test("the lower priority rule wins when two match", async () => {
  const row = await line("ACME FUEL priority", -5_500);
  await rule({ name: "Late", accountId: sales, priority: 200 });
  await rule({ name: "Early", accountId: fuel, priority: 10 });

  await post("/api/bank-rules/apply", {});
  const posted = await postedAgainst(row.id);
  expect(posted?.lines.some((l) => l.accountId === fuel)).toBe(true);
  expect(posted?.lines.some((l) => l.accountId === sales)).toBe(false);

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

test("a disabled rule does nothing", async () => {
  const row = await line("ACME FUEL disabled", -700);
  await rule({ enabled: false });
  await post("/api/bank-rules/apply", {});
  expect(await postedAgainst(row.id)).toBeNull();

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

/**
 * The control that makes writing one safe.
 *
 * Somebody who is not sure what they are doing types a rule matching on "a"
 * and would otherwise find out by way of a hundred journal entries. The
 * preview answers from the rule as typed, before it is saved, and has to agree
 * with what the rule then does — a preview that lies is worse than none.
 */
test("a preview says what the rule would take, and agrees with what it takes", async () => {
  const one = await line("ACME FUEL preview a", -1_100);
  await line("ACME FUEL preview b", -1_200, { pending: true });
  await line("ACME FUEL preview c", -1_400, {
    matchedEntryId: crypto.randomUUID(),
  });
  await line("SOMETHING ELSE", -1_300);

  const res = await post("/api/bank-rules/preview", {
    name: "Fuel",
    matchText: "acme fuel preview",
    accountId: fuel,
  });
  expect(res.status).toBe(200);
  const preview = (await res.json()) as {
    matched: number;
    wouldPost: number;
    examples: unknown[];
  };
  // Three lines say the words. One is pending and one is already reconciled,
  // so only one of them is a line a rule may post — which is the difference
  // between "this rule does nothing" and "this rule is too late".
  expect(preview.matched).toBe(3);
  expect(preview.wouldPost).toBe(1);
  expect(preview.examples).toHaveLength(3);

  await rule({ matchText: "acme fuel preview" });
  const run = await post("/api/bank-rules/apply", {});
  expect(((await run.json()) as { applied: number }).applied).toBe(
    preview.wouldPost,
  );
  expect(await postedAgainst(one.id)).not.toBeNull();

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

/**
 * Directly, because nothing can reach it through a route.
 *
 * `readRule` refuses an empty rule at the door, so the guard inside the
 * matcher is never met by anything a person can send — and an assertion that
 * cannot fail is worth nothing. `ruleMatches` is exported and is what the
 * preview, the applier and anything written later all ask, so it is tested as
 * the function it is.
 */
test("a rule with no words in it claims nothing, asked directly", () => {
  const row = {
    ...({} as unknown as typeof schema.bankTransactions.$inferSelect),
    description: "ANYTHING AT ALL",
    amountCents: -100,
    matchedEntryId: null,
    pending: false,
  };
  const empty = {
    ...({} as unknown as typeof schema.bankRules.$inferSelect),
    enabled: true,
    matchType: "contains",
    matchText: "   ",
    direction: "any",
    minCents: null,
    maxCents: null,
  };
  expect(ruleMatches(empty, row)).toBe(false);
  // And the same rule with words in it does claim it, so the false above is
  // the empty text rather than the stub.
  expect(ruleMatches({ ...empty, matchText: "anything" }, row)).toBe(true);
});

/**
 * Off, rather than gone.
 *
 * A supplier changes or a subscription pauses, and the rule is wrong for a
 * month. Deleting it loses the count of what it has already done — the only
 * record of how much of the bookkeeping it was doing — so the screen turns it
 * off, and this is the route behind that.
 */
test("a rule can be turned off and back on without losing its history", async () => {
  const made = await rule({ name: "Pausable" });
  const row = await line("ACME FUEL paused", -2_500);

  const off = await req(`/api/bank-rules/${made.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "Pausable",
      matchText: "acme fuel",
      accountId: fuel,
      enabled: false,
    }),
  });
  expect(off.status).toBe(200);
  expect(((await off.json()) as { rule: BankRuleRow }).rule.enabled).toBe(
    false,
  );

  await post("/api/bank-rules/apply", {});
  expect(await postedAgainst(row.id)).toBeNull();

  const on = await req(`/api/bank-rules/${made.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "Pausable",
      matchText: "acme fuel",
      accountId: fuel,
      enabled: true,
    }),
  });
  expect(on.status).toBe(200);

  await post("/api/bank-rules/apply", {});
  expect(await postedAgainst(row.id)).not.toBeNull();

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

/**
 * A real rule, in a real second business.
 *
 * An id that exists nowhere answers 404 whether the route is scoped or not, so
 * that version of this test held nothing — the same trap the journal's
 * reversal test fell into. This one makes a rule as another business and asks
 * the first to change and delete it, which is what a leak would look like.
 */
test("another business's rule cannot be changed or deleted", async () => {
  const other = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-rules-${suffix}` },
    headers,
  });
  if (!other) throw new Error("could not create the second organization");
  otherOrgId = other.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: other.id },
    headers,
  });

  const theirAccount = await account("6100", "Fuel", "expense");
  const theirs = await rule({ name: "Theirs", accountId: theirAccount });

  /**
   * And a line of theirs for a rule of ours to reach for.
   *
   * `applyRules` sweeps unreconciled statement lines. Without the organization
   * on that query it sweeps everybody's, and a rule written by one business
   * posts another business's fuel into its own expense account — a leak that
   * writes to two sets of books at once.
   */
  const [theirLine] = await db
    .insert(schema.bankTransactions)
    .values({
      organizationId: other.id,
      importId,
      date: new Date("2026-08-16T00:00:00Z"),
      description: "ACME FUEL theirs",
      amountCents: -6_600,
      bankAccountId: theirAccount,
    })
    .returning();
  if (!theirLine) throw new Error("their statement line was not written");

  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const strangers = theirs.id;
  const changed = await req(`/api/bank-rules/${strangers}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "Theirs",
      matchText: "anything",
      accountId: fuel,
    }),
  });
  expect(changed.status).toBe(404);

  const deleted = await req(`/api/bank-rules/${strangers}`, {
    method: "DELETE",
  });
  expect(deleted.status).toBe(404);

  // And it is still theirs, unchanged.
  const [after] = await db
    .select()
    .from(schema.bankRules)
    .where(eq(schema.bankRules.id, strangers))
    .limit(1);
  expect(after?.name).toBe("Theirs");

  // Nor does our own rule reach across and post their statement line.
  await rule({ name: "Ours", matchText: "acme fuel theirs" });
  await post("/api/bank-rules/apply", {});
  const [theirsAfter] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, theirLine.id))
    .limit(1);
  expect(theirsAfter?.matchedEntryId).toBeNull();

  /**
   * And our own books gained nothing from it.
   *
   * Their row staying unreconciled is not the whole answer: the write that
   * marks a line is scoped even when the sweep is not, so an unscoped sweep
   * shows up as an entry posted into *our* ledger against *their* account and
   * their statement line left looking untouched. That is the leak, and it is
   * on our side of it.
   */
  const ours = await db
    .select({ accountId: schema.journalLines.accountId })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(ours.some((l) => l.accountId === theirAccount)).toBe(false);

  await db
    .delete(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, orgId));
});

test("a rule with nothing to match on is refused", async () => {
  const res = await post("/api/bank-rules", {
    name: "Everything",
    matchText: "   ",
    accountId: fuel,
  });
  // It would claim every line on the statement.
  expect(res.status).toBe(400);
});

test("a rule cannot post into another business's account", async () => {
  const res = await post("/api/bank-rules", {
    name: "Theirs",
    matchText: "anything",
    accountId: crypto.randomUUID(),
  });
  expect(res.status).toBe(400);
  // Named, so it cannot pass on some other complaint about the body.
  expect(((await res.json()) as { error: string }).error).toContain(
    "not an account of yours",
  );
});

test("a rule whose smallest amount is above its largest is refused", async () => {
  const res = await post("/api/bank-rules", {
    name: "Impossible",
    matchText: "anything",
    accountId: fuel,
    minCents: 10_000,
    maxCents: 100,
  });
  // It silently matches nothing otherwise, which reads as a broken product.
  expect(res.status).toBe(400);
});

/**
 * Getting out of it.
 *
 * A rule applied to two hundred lines is two hundred entries, and the person
 * who has to undo that is the reason this route exists. It reverses rather
 * than deletes, so the mistake and the correction are both in the books.
 */
test("undoing a categorisation reverses it and frees the line", async () => {
  const row = await line("ACME FUEL undo", -3_300);
  const done = await post(`/api/bank-transactions/${row.id}/categorise`, {
    accountId: fuel,
  });
  expect(done.status).toBe(201);
  const first = await postedAgainst(row.id);
  expect(first).not.toBeNull();

  const undone = await post(
    `/api/bank-transactions/${row.id}/uncategorise`,
    {},
  );
  expect(undone.status).toBe(200);

  const [after] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, row.id))
    .limit(1);
  expect(after?.matchedEntryId).toBeNull();

  // The original is still there, with its mirror beside it.
  const reversal = await db
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, `reversal:${first?.entry?.id}`),
      ),
    );
  expect(reversal).toHaveLength(1);
});

/**
 * And not out of somebody else's work.
 *
 * A line reconciled against an invoice carries a payment and a document.
 * Reversing that from a statement screen would leave the invoice saying it was
 * paid and the books saying it was not.
 */
test("a line reconciled against an invoice is not undone from here", async () => {
  const row = await line("PAYMENT FOR INVOICE", 5_000);
  const { entry } = await postSomethingElse(row.id);

  const res = await post(`/api/bank-transactions/${row.id}/uncategorise`, {});
  expect(res.status).toBe(409);

  const [after] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, row.id))
    .limit(1);
  expect(after?.matchedEntryId).toBe(entry);
});

/** An entry that did not come from a rule or a categorisation. */
async function postSomethingElse(rowId: string) {
  const [entry] = await db
    .insert(schema.journalEntries)
    .values({
      organizationId: orgId,
      memo: "Invoice INV-1 paid",
      source: "invoice:INV-1",
      postedAt: new Date(),
    })
    .returning();
  if (!entry) throw new Error("the entry was not written");
  await db
    .update(schema.bankTransactions)
    .set({ matchedEntryId: entry.id })
    .where(eq(schema.bankTransactions.id, rowId));
  return { entry: entry.id };
}

test("categorising against the bank account itself is refused", async () => {
  const row = await line("ACME FUEL self", -900);
  const res = await post(`/api/bank-transactions/${row.id}/categorise`, {
    accountId: bank,
  });
  // It balances perfectly and says nothing, so nothing downstream would ever
  // question it.
  expect(res.status).toBe(400);
});

test("a line already reconciled cannot be categorised again", async () => {
  const row = await line("ACME FUEL twice", -1_500);
  expect(
    (
      await post(`/api/bank-transactions/${row.id}/categorise`, {
        accountId: fuel,
      })
    ).status,
  ).toBe(201);
  const again = await post(`/api/bank-transactions/${row.id}/categorise`, {
    accountId: fuel,
  });
  expect(again.status).toBe(409);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { daysLate } from "@sentrello/db/day";
import { eq } from "@sentrello/db/orm";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import { lateFeeFor, rulesDue, runReminders } from "./reminders";

/**
 * Today, at ten in the morning, because the sweep now asks what hour it is.
 *
 * A chase goes out at eight in the morning *where the business is*, so the hour
 * on the clock decides whether anything is sent. These tests passed `new Date()`
 * and were therefore green all afternoon and red before eight — a suite that
 * depends on the hour somebody happens to run it is not a suite. The day is
 * today's, because every due date here is set as an offset from now and the
 * arithmetic has to stay true.
 */
function businessMorning(): Date {
  const at = new Date();
  at.setUTCHours(10, 0, 0, 0);
  return at;
}

/**
 * Chasing by rule, and charging for being late.
 *
 * The two things worth protecting here both cost a business its customers if
 * they go wrong: sending the same firm letter four times in a morning, and
 * charging a fee nobody agreed to.
 */

const orgId = `reminders-test-${crypto.randomUUID().slice(0, 8)}`;
let invoiceId: string;
let contactId: string;

const saved = { resend: process.env.RESEND_API_KEY };

/** Where the reminders go in these tests. Nothing leaves the process. */
const outbox: { to: string; subject: string; html: string }[] = [];
const mailer = {
  async send(m: { to: string; subject: string; html: string }) {
    outbox.push(m);
  },
};

beforeAll(async () => {
  // Mail "configured", so the run does not bail out before doing anything.
  // Nothing leaves the process: the adapter has no real transport in tests.
  // Only so `mailConfigured()` is true; the mailer below is what is used.
  process.env.RESEND_API_KEY = "test-key-for-reminders";

  // The invoice and its customer belong to a business that exists: every
  // business table has named one with a foreign key since 2026-09-27.
  await makeOrganization(orgId);

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Priya Raman",
      email: "priya@example.test",
      kind: "customer",
    })
    .returning();
  if (!contact) throw new Error("no contact");
  contactId = contact.id;

  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId: contact.id,
      number: "INV-RULES",
      status: "open",
      currency: "USD",
      issueDate: new Date(Date.now() - 60 * 86_400_000),
      dueDate: new Date(Date.now() - 30 * 86_400_000),
      subtotalCents: 100_000,
      totalCents: 100_000,
    })
    .returning();
  if (!invoice) throw new Error("no invoice");
  invoiceId = invoice.id;
});

afterAll(async () => {
  process.env.RESEND_API_KEY = saved.resend;
  await dropOrganization(orgId);
});

// ---------------------------------------------------------------------------
// The arithmetic, on its own
// ---------------------------------------------------------------------------

test("a rule fires once its day has passed, not only on the day", () => {
  // Otherwise a job that fails to run on a Tuesday means that reminder is
  // never sent at all.
  const rules = [
    { id: "before", daysOffset: -3 },
    { id: "on", daysOffset: 0 },
    { id: "after", daysOffset: 14 },
  ];
  expect(rulesDue(rules, -5).map((r) => r.id)).toEqual([]);
  expect(rulesDue(rules, -3).map((r) => r.id)).toEqual(["before"]);
  expect(rulesDue(rules, 20).map((r) => r.id)).toEqual([
    "before",
    "on",
    "after",
  ]);
});

test("a late fee is never bigger than the debt", () => {
  // A fee larger than the balance is a typed-in percentage nobody meant.
  expect(
    lateFeeFor({ lateFeeType: "percent", lateFeeValue: 500 }, 100_000),
  ).toBe(5000);
  expect(
    lateFeeFor({ lateFeeType: "amount", lateFeeValue: 999_999 }, 10_000),
  ).toBe(10_000);
  // Off unless configured.
  expect(lateFeeFor({ lateFeeType: null, lateFeeValue: 500 }, 100_000)).toBe(0);
  expect(lateFeeFor({ lateFeeType: "percent", lateFeeValue: 0 }, 100_000)).toBe(
    0,
  );
});

test("days late is whole days, counted where the business is", () => {
  const due = new Date("2026-08-20T00:00:00Z");
  expect(daysLate(due, new Date("2026-08-25T00:00:00Z"), null)).toBe(5);
  expect(daysLate(due, new Date("2026-08-18T00:00:00Z"), null)).toBe(-2);

  /*
   * The whole of the due day is 0, and the evening of the day before is -1.
   *
   * This is the arithmetic the chase rules are read in, so an offset of 0 has
   * to mean the day the invoice says — not the moment the clock passed it. On
   * a host keeping UTC, nine in the evening in New York on the 19th is already
   * the 20th in UTC, and a "chase on the due date" rule went out a day early
   * for every American business.
   */
  expect(daysLate(due, new Date("2026-08-20T23:30:00Z"), null)).toBe(0);
  expect(
    daysLate(due, new Date("2026-08-20T01:00:00Z"), "America/New_York"),
  ).toBe(-1);
  expect(
    daysLate(due, new Date("2026-08-21T03:00:00Z"), "America/New_York"),
  ).toBe(0);
});

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

test("a rule chases once, and a rerun sends nothing", async () => {
  // The failure this prevents: a scheduler that reruns, or two processes on
  // the same minute, and a customer receives the same firm letter twice.
  const [rule] = await db
    .insert(schema.reminderRules)
    .values({
      organizationId: orgId,
      name: "Fourteen days late",
      daysOffset: 14,
      subject: "Invoice {{number}} is overdue",
      body: "{{amount}} is outstanding on {{number}}.",
      active: true,
    })
    .returning();
  if (!rule) throw new Error("no rule");

  const first = await runReminders(businessMorning(), { mailer });
  expect(first.sent).toBeGreaterThan(0);

  const logged = await db
    .select()
    .from(schema.reminderLog)
    .where(eq(schema.reminderLog.invoiceId, invoiceId));
  expect(logged).toHaveLength(1);
  expect(logged[0]?.sentTo).toBe("priya@example.test");

  // Run it again: the rule has already fired for this invoice.
  const second = await runReminders(businessMorning(), { mailer });
  const stillLogged = await db
    .select()
    .from(schema.reminderLog)
    .where(eq(schema.reminderLog.invoiceId, invoiceId));
  expect(stillLogged).toHaveLength(1);
  expect(second.sent).toBe(0);
});

test("a second rule fires on the next run, not all at once", async () => {
  // A business that adds four rules to an invoice already sixty days late
  // should not send all four in the same minute.
  await db.insert(schema.reminderRules).values([
    {
      organizationId: orgId,
      name: "Twenty-one days",
      daysOffset: 21,
      subject: "Still outstanding: {{number}}",
      body: "Please settle {{amount}}.",
      active: true,
    },
    {
      organizationId: orgId,
      name: "Twenty-eight days",
      daysOffset: 28,
      subject: "Final notice for {{number}}",
      body: "{{amount}} remains unpaid.",
      active: true,
    },
  ]);

  const run = await runReminders(businessMorning(), { mailer });
  expect(run.sent).toBe(1);

  const logged = await db
    .select()
    .from(schema.reminderLog)
    .where(eq(schema.reminderLog.invoiceId, invoiceId));
  expect(logged).toHaveLength(2);
});

test("a late fee is applied once, after the grace period", async () => {
  await db.insert(schema.invoicingSettings).values({
    organizationId: orgId,
    lateFeeType: "percent",
    lateFeeValue: 500, // 5%
    lateFeeGraceDays: 7,
  });

  const before = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  const wasTotal = before[0]?.totalCents ?? 0;

  const run = await runReminders(businessMorning(), { mailer });
  expect(run.feesApplied).toBe(1);

  const [after] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  expect(after?.lateFeeCents).toBe(Math.round((wasTotal * 500) / 10000));
  expect(after?.totalCents).toBe(wasTotal + (after?.lateFeeCents ?? 0));
  expect(after?.lateFeeAppliedAt).toBeTruthy();

  // A rerun must not charge it again — the invoice records that it was.
  const again = await runReminders(businessMorning(), { mailer });
  expect(again.feesApplied).toBe(0);
  const [unchanged] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  expect(unchanged?.totalCents).toBe(after?.totalCents);

  /*
   * And the ledger agrees with the invoice, which it did not until
   * 2026-09-28. The fee was added to `totalCents` and posted nowhere, so
   * the invoice asked for more than Accounts Receivable said was owed —
   * for ever, because nothing ever reconciled it. A breach of the rule
   * that every financial event posts a balanced entry, sitting behind a
   * feature that is off by default, which is why no customer found it.
   */
  const fee = after?.lateFeeCents ?? 0;
  const entry = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `late-fee:${invoiceId}`));
  expect(entry).toHaveLength(1);

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, String(entry[0]?.id)));
  const debits = lines.reduce((n, l) => n + (l.debitCents ?? 0), 0);
  const credits = lines.reduce((n, l) => n + (l.creditCents ?? 0), 0);
  expect(debits).toBe(fee);
  expect(credits).toBe(fee);

  // Posted once, however many times the sweep runs.
  const afterRerun = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `late-fee:${invoiceId}`));
  expect(afterRerun).toHaveLength(1);
});

/**
 * The chase asks for the fee once, not once per run.
 *
 * `balanceDue` is worked out from `totalCents`, and applying the fee
 * raises it — so adding `lateFeeCents` on top was right on the single run
 * that applied it, and wrong on every run after: the next chase asked for
 * the fee twice, the one after for three times.
 *
 * Asserted on its own invoice and its own rule, because the fee and the
 * settings are per organization and a test that edits them underneath the
 * others is a test that breaks them. This one restores what it changed.
 */
test("a later chase does not ask for the late fee again", async () => {
  const [before] = await db
    .select()
    .from(schema.invoicingSettings)
    .where(eq(schema.invoicingSettings.organizationId, orgId));

  try {
    await db
      .update(schema.invoicingSettings)
      .set({ lateFeeType: "amount", lateFeeValue: 5_000, lateFeeGraceDays: 1 })
      .where(eq(schema.invoicingSettings.organizationId, orgId));

    // A fresh invoice, so nothing already charged on the shared one counts.
    const [own] = await db
      .insert(schema.invoices)
      .values({
        organizationId: orgId,
        contactId,
        number: `LATE-${crypto.randomUUID().slice(0, 6)}`,
        status: "open",
        currency: "GBP",
        issueDate: new Date(Date.now() - 60 * 24 * 3600 * 1000),
        dueDate: new Date(Date.now() - 40 * 24 * 3600 * 1000),
        subtotalCents: 100_000,
        taxCents: 0,
        totalCents: 100_000,
      })
      .returning();
    const id = String(own?.id);

    await runReminders(businessMorning(), { mailer });
    const [charged] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id));
    expect(charged?.lateFeeCents).toBe(5_000);
    expect(charged?.totalCents).toBe(105_000);

    // Chase it again: the rule log is what stops a second send, so clearing
    // it is how a later rule on the same invoice behaves.
    await db
      .delete(schema.reminderLog)
      .where(eq(schema.reminderLog.invoiceId, id));
    outbox.length = 0;
    await runReminders(businessMorning(), { mailer });

    const asked = outbox.at(-1)?.html ?? "";
    expect(asked).toContain("1,050.00");
    // The fee counted twice would read 1,100.00.
    expect(asked).not.toContain("1,100.00");

    await db.delete(schema.invoices).where(eq(schema.invoices.id, id));
  } finally {
    await db
      .update(schema.invoicingSettings)
      .set({
        lateFeeType: before?.lateFeeType ?? null,
        lateFeeValue: before?.lateFeeValue ?? 0,
        lateFeeGraceDays: before?.lateFeeGraceDays ?? 0,
      })
      .where(eq(schema.invoicingSettings.organizationId, orgId));
  }
});

test("a paid invoice is neither chased nor charged", async () => {
  // Settled is settled, whatever the rules say.
  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  await db.insert(schema.payments).values({
    organizationId: orgId,
    invoiceId,
    amountCents: invoice?.totalCents ?? 0,
  });

  const run = await runReminders(businessMorning(), { mailer });
  expect(run.sent).toBe(0);
  expect(run.feesApplied).toBe(0);

  await db
    .delete(schema.payments)
    .where(eq(schema.payments.invoiceId, invoiceId));
  expect(contactId).toBeTruthy();
});

test("a reminder that could not be sent is tried again next run", async () => {
  // A mail server down for an hour must not lose that reminder for ever. The
  // claim on the log is released when the send fails, so the next run picks
  // it up — the failure this is guarding against is silence, not a duplicate.
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId,
      number: "INV-RETRY",
      status: "open",
      currency: "USD",
      issueDate: new Date(Date.now() - 60 * 86_400_000),
      dueDate: new Date(Date.now() - 30 * 86_400_000),
      subtotalCents: 50_000,
      totalCents: 50_000,
    })
    .returning();
  if (!invoice) throw new Error("no invoice");

  const broken = {
    async send() {
      throw new Error("the mail server is not answering");
    },
  };

  const failed = await runReminders(businessMorning(), { mailer: broken });
  expect(failed.sent).toBe(0);

  // Nothing is claimed, so it is still owed a reminder.
  const afterFailure = await db
    .select()
    .from(schema.reminderLog)
    .where(eq(schema.reminderLog.invoiceId, invoice.id));
  expect(afterFailure).toHaveLength(0);

  const recovered = await runReminders(businessMorning(), { mailer });
  expect(recovered.sent).toBeGreaterThan(0);
  const afterSuccess = await db
    .select()
    .from(schema.reminderLog)
    .where(eq(schema.reminderLog.invoiceId, invoice.id));
  expect(afterSuccess).toHaveLength(1);

  await db.delete(schema.invoices).where(eq(schema.invoices.id, invoice.id));
});

test("the wording a business wrote is what goes out", async () => {
  // Placeholders are the whole point of letting somebody write their own
  // reminder: a letter that says "{{amount}} is outstanding" is worse than
  // no letter at all.
  const sent = outbox.at(-1);
  expect(sent?.subject).not.toContain("{{");
  expect(sent?.html).not.toContain("{{");
  expect(sent?.subject).toMatch(/INV-/);
});

/**
 * The figures in a business's own chase are the product's figures.
 *
 * This path filled its placeholders by hand: `{{amount}}` came out as
 * "1450.00" with no currency and no separator, and `{{due}}` as
 * "Sat Oct 10 2026" — JavaScript's own `toDateString`, in the server's
 * timezone, which is the fault that was fixed in ten other places the same
 * morning. Every other message in the product formats money with the
 * seller's locale and reads a due date in UTC.
 */
test("the money and the date look like the rest of the product", async () => {
  const sent = outbox.at(-1);
  // A currency symbol and a thousands separator, not a bare number.
  expect(sent?.html, "money in a chase is written as money").toMatch(
    /[$£€]\s?[\d,.]+/,
  );
  expect(
    sent?.html,
    "a bare unformatted figure reached a customer",
    // The bare `(cents / 100).toFixed(2)` this used to interpolate: a
    // number with nothing in front of it, straight after the paragraph tag.
  ).not.toMatch(/<p>\d/);
  // And nothing shaped like `Sat Oct 10 2026`.
  expect(sent?.html, "a date went out in the server's own dialect").not.toMatch(
    /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{2} \d{4}\b/,
  );
});

test("a fee is not charged during the grace period", async () => {
  // A fee charged the morning after the due date is a fee charged for a
  // payment already in the post. Grace is what makes the rule survive contact
  // with customers — and without a test inside the window, removing the check
  // entirely changes nothing anybody would notice.
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId,
      number: "INV-GRACE",
      status: "open",
      currency: "USD",
      issueDate: new Date(Date.now() - 33 * 86_400_000),
      // Three days late, against a seven-day grace.
      dueDate: new Date(Date.now() - 3 * 86_400_000),
      subtotalCents: 40_000,
      totalCents: 40_000,
    })
    .returning();
  if (!invoice) throw new Error("no invoice");

  await runReminders(businessMorning(), { mailer });

  const [untouched] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  expect(untouched?.lateFeeCents).toBe(0);
  expect(untouched?.lateFeeAppliedAt).toBeNull();

  // Once it is past the grace period, it is charged.
  await db
    .update(schema.invoices)
    .set({ dueDate: new Date(Date.now() - 10 * 86_400_000) })
    .where(eq(schema.invoices.id, invoice.id));

  const run = await runReminders(businessMorning(), { mailer });
  expect(run.feesApplied).toBe(1);

  const [charged] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  expect(charged?.lateFeeCents).toBe(2000); // 5% of 400.00

  await db.delete(schema.invoices).where(eq(schema.invoices.id, invoice.id));
});

/**
 * One address that will not take mail is one invoice, not the sweep.
 *
 * The rule-driven branch already caught its own send failure and carried on.
 * The built-in weekly chase — the branch a business that has configured
 * nothing actually runs — did not, so a rejected recipient threw out of
 * `runReminders` entirely: every invoice after it went unchased, in every
 * business on the instance, and the retry hit the same invoice again.
 */
test("a chase that will not send loses one invoice, not the whole run", async () => {
  // A second business, and a real one: the sweep runs across every
  // organization, and since 2026-09-27 an invented id can own nothing.
  const failOrg = await makeOrganization(
    `reminders-fail-${crypto.randomUUID().slice(0, 8)}`,
  );
  const [gone, fine] = await db
    .insert(schema.contacts)
    .values([
      {
        organizationId: failOrg,
        name: "Gone Away",
        email: "bounces@example.test",
        kind: "customer",
      },
      {
        organizationId: failOrg,
        name: "Still Here",
        email: "reachable@example.test",
        kind: "customer",
      },
    ])
    .returning();
  if (!gone || !fine) throw new Error("no contacts");

  // No rules for this organization, so both fall to the built-in chase.
  for (const [number, contact] of [
    ["INV-BOUNCES", gone],
    ["INV-REACHABLE", fine],
  ] as const) {
    await db.insert(schema.invoices).values({
      organizationId: failOrg,
      contactId: contact.id,
      number,
      status: "open",
      currency: "USD",
      issueDate: new Date(Date.now() - 60 * 86_400_000),
      dueDate: new Date(Date.now() - 30 * 86_400_000),
      subtotalCents: 50_000,
      totalCents: 50_000,
    });
  }

  const reached: string[] = [];
  const halfBroken = {
    async send(m: { to: string; subject: string; html: string }) {
      if (m.to === "bounces@example.test") {
        throw new Error("550 no such mailbox");
      }
      reached.push(m.to);
    },
  };

  try {
    const run = await runReminders(businessMorning(), { mailer: halfBroken });
    expect(reached).toContain("reachable@example.test");
    expect(run.sent).toBeGreaterThan(0);

    // And the one that failed was not stamped as chased, so the next run
    // tries it again rather than waiting a week on a send that never went.
    const [bounced] = await db
      .select({ lastReminderAt: schema.invoices.lastReminderAt })
      .from(schema.invoices)
      .where(eq(schema.invoices.number, "INV-BOUNCES"));
    expect(bounced?.lastReminderAt).toBeNull();
  } finally {
    await dropOrganization(failOrg);
  }
});

/**
 * Eight in the morning where the business is, not where the server is.
 *
 * The sweep ran at eight o'clock **UTC** — two in the morning in Denver, nine or
 * ten in Berlin. Every one of these is a letter to somebody else's customer
 * asking them for money, and on our first market it arrived overnight: at the
 * bottom of an inbox by the time anybody read it, and looking like something
 * nobody had looked at. pg-boss parses a cron in UTC and there is nowhere to tell
 * it otherwise, because the schedule is registered once at boot and the timezone
 * belongs to the organization. So the sweep is hourly and the hour lives in the
 * job, which already reads that timezone to count the days a rule is offset from.
 *
 * A floor rather than an exact hour, because the log is one row per rule per
 * invoice: the first tick at or after eight sends, every later one finds the work
 * done, and an hour the process spent restarting is caught up at nine.
 */
test("nothing is chased before the morning, and everything is after it", async () => {
  // A zone a long way west of the server's, where eight o'clock UTC is the
  // middle of the night.
  await db
    .update(schema.organizations)
    .set({ timezone: "America/Denver" })
    .where(eq(schema.organizations.id, orgId));

  // A rule nothing has fired yet, so the log cannot be what keeps it quiet.
  const [rule] = await db
    .insert(schema.reminderRules)
    .values({
      organizationId: orgId,
      name: "Twenty-one days late",
      daysOffset: 21,
      subject: "Invoice {{number}} is a long way overdue",
      body: "{{amount}} is still outstanding on {{number}}.",
      active: true,
    })
    .returning();
  if (!rule) throw new Error("no rule");

  try {
    const atNight = new Date();
    // 08:00 UTC — one or two in the morning in Denver, and the hour this swept
    // at for its whole life.
    atNight.setUTCHours(8, 0, 0, 0);
    const quiet = await runReminders(atNight, { mailer });
    expect(
      quiet.sent,
      "a chase went out in the middle of the night where the business is",
    ).toBe(0);

    const atWork = new Date();
    // 16:00 UTC is nine in Denver in summer and ten in winter; either is past
    // the eight o'clock floor, which is what this asserts rather than a wall
    // clock of its own.
    atWork.setUTCHours(16, 0, 0, 0);
    const chased = await runReminders(atWork, { mailer });
    expect(chased.sent).toBeGreaterThan(0);
  } finally {
    await db
      .update(schema.organizations)
      .set({ timezone: null })
      .where(eq(schema.organizations.id, orgId));
    await db
      .delete(schema.reminderLog)
      .where(eq(schema.reminderLog.ruleId, rule.id));
    await db
      .delete(schema.reminderRules)
      .where(eq(schema.reminderRules.id, rule.id));
  }
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  ARCHIVE_FORMAT,
  type ArchivePlan,
  VerificationFailed,
  planArchive,
  removeArchived,
  restoreArchive,
  retentionCutoff,
  retentionYears,
  verifyArchive,
  writeArchive,
} from "./archive";
import { balanceOf } from "./archive-test-helpers";
import { db } from "./client";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  ledgerRows,
  ledgerTotals,
  postJournalEntry,
} from "./ledger";
import { eq, inArray, sql } from "./orm";
import * as schema from "./schema";

/**
 * The archive, tested in the order it must never be allowed to fail.
 *
 * The verification test comes first on purpose, and so does the one that
 * proves a refused archive deletes nothing: everything else here is a feature,
 * and those two are the promise. A business that archives 2019 and finds the
 * file unreadable must still have 2019.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgId = `archive-${suffix}`;
const otherOrgId = `archive-other-${suffix}`;

let sales = "";
let bank = "";
let otherSales = "";
let otherBank = "";

async function makeOrg(id: string, country: string) {
  await db.insert(schema.organizations).values({
    id,
    name: `Archive ${id}`,
    slug: id,
    countryCode: country,
    createdAt: new Date(),
  });
}

/** An invoice's worth of double entry, posted on a day. */
async function post(
  org: string,
  debit: string,
  credit: string,
  cents: number,
  on: Date,
) {
  return postJournalEntry(
    org,
    `takings ${on.toISOString().slice(0, 10)}`,
    "test",
    [
      { accountId: debit, debitCents: cents },
      { accountId: credit, creditCents: cents },
    ],
    on,
  );
}

beforeAll(async () => {
  await makeOrg(orgId, "GB");
  await makeOrg(otherOrgId, "GB");

  bank = await ensureAccount(orgId, CORE_ACCOUNTS.cash);
  sales = await ensureAccount(orgId, CORE_ACCOUNTS.salesIncome);
  otherBank = await ensureAccount(otherOrgId, CORE_ACCOUNTS.cash);
  otherSales = await ensureAccount(otherOrgId, CORE_ACCOUNTS.salesIncome);

  // Three months of 2015, well outside every retention window we hold anybody
  // to, plus one entry in 2024 that must survive every archive of 2015.
  for (const [month, cents] of [
    [0, 10_000],
    [0, 2_500],
    [1, 7_000],
    [2, 33_300],
  ] as const) {
    await post(orgId, bank, sales, cents, new Date(Date.UTC(2015, month, 14)));
  }
  await post(orgId, bank, sales, 999_99, new Date(Date.UTC(2024, 5, 1)));

  // The other business, in the same months and the same accounts.
  await post(
    otherOrgId,
    otherBank,
    otherSales,
    555_55,
    new Date(Date.UTC(2015, 0, 14)),
  );

  await db.insert(schema.ledgerSettings).values({
    organizationId: orgId,
    closedThrough: new Date(Date.UTC(2020, 11, 31)),
  });
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    const entries = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, org));
    if (entries.length) {
      await db.delete(schema.journalLines).where(
        inArray(
          schema.journalLines.entryId,
          entries.map((e) => e.id),
        ),
      );
    }
    for (const [table, column] of [
      [schema.journalEntries, schema.journalEntries.organizationId],
      [schema.accounts, schema.accounts.organizationId],
      [schema.ledgerSettings, schema.ledgerSettings.organizationId],
      [schema.recordEvents, schema.recordEvents.organizationId],
    ] as const) {
      await db.delete(table).where(eq(column, org));
    }
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org));
  }
});

const YEAR_2015 = {
  from: new Date(Date.UTC(2015, 0, 1)),
  to: new Date(Date.UTC(2015, 11, 31, 23, 59, 59, 999)),
};

async function bytesOf(
  plan: ArchivePlan,
  archiveId?: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of writeArchive(plan, archiveId)) {
    chunks.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function ledgerCount(org: string): Promise<number> {
  const rows = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, org));
  return rows.length;
}

// ---------------------------------------------------------------------------
// The promise, first
// ---------------------------------------------------------------------------

test("a damaged archive is refused and nothing local is deleted", async () => {
  const plan = await planArchive(orgId, "ledger", YEAR_2015.from, YEAR_2015.to);
  expect(plan.blockers).toEqual([]);
  const before = await ledgerCount(orgId);
  expect(before).toBe(5);

  const archive = await bytesOf(plan);
  // One byte, in the compressed body of the first member. This is exactly what
  // a bad disk or a truncated upload looks like, and it is the case the whole
  // ordering of this feature exists for.
  const damaged = new Uint8Array(archive);
  const at = 30 + "README.txt".length + 4;
  damaged[at] = (damaged[at] as number) ^ 0xff;

  expect(verifyArchive([damaged])).rejects.toThrow();

  // And the deletion never runs, because it is only ever reached with a
  // verification in hand.
  expect(await ledgerCount(orgId)).toBe(before);
});

test("an archive whose manifest disagrees with the database is refused", async () => {
  const plan = await planArchive(orgId, "ledger", YEAR_2015.from, YEAR_2015.to);
  const verified = await verifyArchive([await bytesOf(plan)]);

  // The books gained an entry between the export and the removal — which is
  // the race this guard exists for, staged here by claiming one more.
  const stale: ArchivePlan = {
    ...plan,
    counts: plan.counts.map((c) =>
      c.table === "journal_entries" ? { ...c, rows: c.rows + 1 } : c,
    ),
  };
  expect(
    verifyArchive([await bytesOf(plan)], stale.counts),
  ).rejects.toBeInstanceOf(VerificationFailed);
  expect(verified.manifest.format).toBe(ARCHIVE_FORMAT);
  expect(await ledgerCount(orgId)).toBe(5);
});

// ---------------------------------------------------------------------------
// The statutory floor
// ---------------------------------------------------------------------------

test("each market's floor is the one its own authority sets", () => {
  expect(retentionYears("GB")).toBe(6);
  expect(retentionYears("CA")).toBe(6);
  expect(retentionYears("US")).toBe(7);
  expect(retentionYears("DE")).toBe(10);
  expect(retentionYears("IE")).toBe(10);
  // Somewhere we do not sell, and an instance that has not said: the longest
  // floor we know of, never the shortest.
  expect(retentionYears("JP")).toBe(10);
  expect(retentionYears(null)).toBe(10);
  expect(
    retentionCutoff("GB", new Date("2026-09-17T00:00:00Z")).toISOString(),
  ).toBe("2020-09-17T00:00:00.000Z");
});

test("a period inside the retention window cannot be deleted, and says why", async () => {
  const from = new Date(Date.UTC(2024, 0, 1));
  const to = new Date(Date.UTC(2024, 11, 31, 23, 59, 59, 999));
  const plan = await planArchive(orgId, "ledger", from, to);

  const statutory = plan.blockers.find((b) => b.kind === "statutory");
  expect(statutory).toBeDefined();
  expect(statutory?.message).toContain("6 years");
  expect(statutory?.message).toContain("You can still write the archive");

  // And the refusal is real: removal is not merely discouraged.
  const verified = await verifyArchive([await bytesOf(plan)]);
  expect(removeArchived(plan, verified)).rejects.toThrow(/may not be removed/);
  expect(await ledgerCount(orgId)).toBe(5);
});

test("the same period can still be exported, with everything kept", async () => {
  const from = new Date(Date.UTC(2024, 0, 1));
  const to = new Date(Date.UTC(2024, 11, 31, 23, 59, 59, 999));
  const plan = await planArchive(orgId, "ledger", from, to);
  const verified = await verifyArchive([await bytesOf(plan)]);

  // A full, checksummed copy of a period nobody is allowed to delete. The
  // refusal is on the deletion, never on the export.
  expect(verified.counts.journal_entries).toBe(1);
  expect(verified.counts.journal_lines).toBe(2);
  expect(await ledgerCount(orgId)).toBe(5);
});

test("a period the books are not closed through is refused", async () => {
  const from = new Date(Date.UTC(2021, 0, 1));
  const to = new Date(Date.UTC(2021, 11, 31, 23, 59, 59, 999));
  const plan = await planArchive(
    orgId,
    "ledger",
    from,
    to,
    new Date("2040-01-01T00:00:00Z"),
  );
  expect(plan.blockers.map((b) => b.kind)).toContain("open-books");
});

// ---------------------------------------------------------------------------
// One business's rows, and only one business's
// ---------------------------------------------------------------------------

test("another organization's rows are nowhere in the archive", async () => {
  const plan = await planArchive(orgId, "ledger", YEAR_2015.from, YEAR_2015.to);
  const archive = await bytesOf(plan);
  const text = new TextDecoder().decode(archive);

  // The other business's ids, its accounts and its one distinctive figure —
  // 55555 cents — searched for in the raw bytes as well as the parsed rows,
  // because a leak through a jsonb column would not show up in a row count.
  const verified = await verifyArchive([archive]);
  expect(verified.manifest.organizationId).toBe(orgId);
  expect(verified.counts.journal_entries).toBe(4);
  expect(text).not.toContain(otherOrgId);

  const rows: Record<string, unknown>[] = [];
  const { readZip } = await import("@sentrello/module-sdk");
  for await (const member of readZip([archive])) {
    if (!member.name.startsWith("data/")) continue;
    for (const line of new TextDecoder().decode(member.bytes).split("\n")) {
      if (line) rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  for (const row of rows) {
    if ("organization_id" in row) expect(row.organization_id).toBe(orgId);
    if ("account_id" in row) {
      expect([otherBank, otherSales]).not.toContain(row.account_id as string);
    }
  }
});

// ---------------------------------------------------------------------------
// A live record still pointing at it
// ---------------------------------------------------------------------------

test("an archive that would orphan a live reference is refused", async () => {
  // A change-feed row from 2015 with a webhook delivery from 2024 still
  // carrying it: archiving the event would break the delivery that names it.
  const [event] = await db
    .insert(schema.recordEvents)
    .values({
      organizationId: orgId,
      entity: "contact",
      entityId: crypto.randomUUID(),
      action: "updated",
      at: new Date(Date.UTC(2015, 3, 2)),
    })
    .returning();
  const [kept] = await db
    .insert(schema.recordEvents)
    .values({
      organizationId: orgId,
      entity: "contact",
      entityId: crypto.randomUUID(),
      action: "updated",
      at: new Date(Date.UTC(2015, 3, 3)),
    })
    .returning();
  const delivery = await db
    .insert(schema.crmWebhookDeliveries)
    .values({
      organizationId: orgId,
      webhookId: crypto.randomUUID(),
      eventId: (event as { id: string }).id,
      event: "contact.updated",
      payload: {},
      nextAttemptAt: new Date(),
      createdAt: new Date(Date.UTC(2024, 0, 1)),
    })
    .returning();

  const blocked = await planArchive(
    orgId,
    "activity",
    YEAR_2015.from,
    YEAR_2015.to,
  );
  const reference = blocked.blockers.find((b) => b.kind === "reference");
  expect(reference).toBeDefined();
  expect(reference?.message).toContain("a webhook delivery still carries it");

  // And once the delivery is inside the period too, the pair leaves together
  // and nothing is left pointing at nothing.
  await db
    .update(schema.crmWebhookDeliveries)
    .set({ createdAt: new Date(Date.UTC(2015, 3, 2)) })
    .where(
      eq(schema.crmWebhookDeliveries.id, (delivery[0] as { id: string }).id),
    );

  const allowed = await planArchive(
    orgId,
    "activity",
    YEAR_2015.from,
    YEAR_2015.to,
  );
  expect(allowed.blockers).toEqual([]);
  expect(allowed.rows).toBe(3);

  const verified = await verifyArchive(
    [await bytesOf(allowed)],
    allowed.counts,
  );
  const removal = await removeArchived(allowed, verified);
  expect(removal.counts.find((c) => c.table === "record_events")?.rows).toBe(2);

  const left = await db
    .select({ id: schema.recordEvents.id })
    .from(schema.recordEvents)
    .where(eq(schema.recordEvents.organizationId, orgId));
  expect(left).toHaveLength(0);
  void kept;
});

// ---------------------------------------------------------------------------
// The heart of it: the reports do not move
// ---------------------------------------------------------------------------

test("the same report over the same dates reads the same after an archive", async () => {
  const period = {
    from: new Date(Date.UTC(2015, 0, 1)),
    to: new Date(Date.UTC(2015, 11, 31, 23, 59, 59, 999)),
  };
  const before = balanceOf(await ledgerRows(orgId, period));
  const wholeBefore = balanceOf(await ledgerRows(orgId));
  const januaryBefore = balanceOf(
    await ledgerRows(orgId, {
      from: new Date(Date.UTC(2015, 0, 1)),
      to: new Date(Date.UTC(2015, 0, 31, 23, 59, 59, 999)),
    }),
  );
  expect(before[sales]).toBe(-52_800);
  expect(before[bank]).toBe(52_800);

  const plan = await planArchive(orgId, "ledger", period.from, period.to);
  expect(plan.blockers).toEqual([]);
  const archive = await bytesOf(plan);
  const verified = await verifyArchive([archive], plan.counts);
  const removal = await removeArchived(plan, verified);

  // Four entries out, three monthly summaries in — January's two are one.
  expect(removal.counts.find((c) => c.table === "journal_entries")?.rows).toBe(
    4,
  );
  expect(removal.carriedForward).toHaveLength(3);

  expect(balanceOf(await ledgerRows(orgId, period))).toEqual(before);
  expect(balanceOf(await ledgerRows(orgId))).toEqual(wholeBefore);
  // The same claim through the reports' own reader, which adds up in SQL and
  // so has to be told about the carried-forward summaries by the same means.
  expect(balanceOf(await ledgerTotals(orgId, period))).toEqual(before);
  expect(balanceOf(await ledgerTotals(orgId))).toEqual(wholeBefore);
  // And per month, which is the unit the carry-forward keeps.
  expect(
    balanceOf(
      await ledgerRows(orgId, {
        from: new Date(Date.UTC(2015, 0, 1)),
        to: new Date(Date.UTC(2015, 0, 31, 23, 59, 59, 999)),
      }),
    ),
  ).toEqual(januaryBefore);

  // Every summary balances on its own; nothing was unposted or reversed.
  const summaries = await db.execute(sql`
    select e.id, sum(l.debit_cents)::int as debits, sum(l.credit_cents)::int as credits
    from journal_entries e join journal_lines l on l.entry_id = e.id
    where e.organization_id = ${orgId} and e.source like 'archive:%'
    group by e.id
  `);
  expect(summaries).toHaveLength(3);
  for (const row of summaries as unknown as {
    debits: number;
    credits: number;
  }[]) {
    expect(row.debits).toBe(row.credits);
  }

  // ---- and back again -------------------------------------------------
  const restored = await restoreArchive(orgId, () => [archive]);
  expect(
    restored.inserted.find((i) => i.table === "journal_entries")?.rows,
  ).toBe(4);
  expect(restored.summariesRemoved).toBe(3);
  expect(balanceOf(await ledgerRows(orgId, period))).toEqual(before);
  expect(balanceOf(await ledgerRows(orgId))).toEqual(wholeBefore);
  expect(await ledgerCount(orgId)).toBe(5);

  // Restoring twice changes nothing.
  const again = await restoreArchive(orgId, () => [archive]);
  expect(again.inserted.every((i) => i.rows === 0)).toBe(true);
  expect(await ledgerCount(orgId)).toBe(5);
});

test("an archive cannot be restored into a different business", async () => {
  const plan = await planArchive(orgId, "ledger", YEAR_2015.from, YEAR_2015.to);
  const archive = await bytesOf(plan);
  expect(restoreArchive(otherOrgId, () => [archive])).rejects.toThrow(
    /different business/,
  );
});

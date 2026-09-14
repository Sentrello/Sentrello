import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { ensureAccount, postJournalEntry } from "@sentrello/db/ledger";
import { dropOrganization, dropUsers } from "@sentrello/db/testing";
/**
 * Imported by package name, not by relative path.
 *
 * That is the whole point of this file. Everything below already worked as a
 * relative import inside `pro.ts` and its groups; the question this file
 * answers is whether it still works once asked for the way a caller in
 * another repository will have to ask for it — through
 * `@sentrello/module-accounting`'s declared exports. If one of these
 * signatures changes, this file fails to typecheck before anything using it
 * across the real boundary does.
 */
import {
  type LedgerRow,
  type VatReturn,
  columnIndex,
  dayFrom,
  forHmrc,
  isUuid,
  ledgerRows,
  ownedAccount,
  parseAmountToCents,
  periodFrom,
  totalsByAccount,
  vatReturn,
} from "@sentrello/module-accounting";

test("isUuid — the shape check pro.ts relies on before a query, not after", () => {
  expect(isUuid("0b8f3b6e-6e2b-4b8a-9b0a-5a6b7c8d9e0f")).toBe(true);
  expect(isUuid("not-a-uuid")).toBe(false);
  expect(isUuid("")).toBe(false);
});

test("columnIndex — case-insensitive header lookup with fallbacks", () => {
  const header = ["Date", "Description", "Amount"];
  expect(columnIndex(header, "date")).toBe(0);
  expect(columnIndex(header, "posted", "transaction date", "date")).toBe(0);
  expect(columnIndex(header, "reference")).toBe(-1);
});

test("parseAmountToCents — the bank-CSV amount reader, parentheses and all", () => {
  expect(parseAmountToCents("1,250.00")).toBe(125_000);
  expect(parseAmountToCents("(15.00)")).toBe(-1_500);
  expect(parseAmountToCents("not a number")).toBeNull();
});

test("dayFrom — a bare date reads as the start of that day, or null if it isn't one", () => {
  expect(dayFrom("2026-03-31")?.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  expect(dayFrom("not a date")).toBeNull();
});

function row(
  over: Partial<LedgerRow> & { code: string; type: string },
): LedgerRow {
  return {
    entryId: over.entryId ?? "entry-1",
    classId: over.classId ?? null,
    locationId: over.locationId ?? null,
    accountId: over.accountId ?? `acct-${over.code}`,
    name: over.name ?? `Account ${over.code}`,
    debitCents: 0,
    creditCents: 0,
    postedAt: over.postedAt ?? new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

test("totalsByAccount — an expense account reads its debits as positive", () => {
  const totals = totalsByAccount(
    [row({ code: "5000", type: "expense", debitCents: 1_000 })],
    "expense",
  );
  expect(totals).toEqual([
    {
      accountId: "acct-5000",
      code: "5000",
      name: "Account 5000",
      balanceCents: 1_000,
    },
  ]);
});

test("periodFrom — a bare 'to' date is stretched to the end of that day", () => {
  const period = periodFrom((name) =>
    name === "to" ? "2026-06-30" : undefined,
  );
  expect(period.to?.toISOString()).toBe("2026-06-30T23:59:59.999Z");
});

test("vatReturn and forHmrc — nine boxes, and HMRC's own rounding rules", () => {
  const rows: LedgerRow[] = [
    row({ code: "2200", type: "liability", creditCents: 2_000 }),
    row({ code: "2200", type: "liability", debitCents: 300 }),
    row({ code: "4000", type: "income", creditCents: 10_050 }),
  ];
  const vat: VatReturn = vatReturn(rows);
  expect(vat.vatDueSales).toBe(2_000);
  expect(vat.netVatDue).toBe(1_700);
  const boxes = forHmrc(vat);
  expect(boxes.totalValueSalesExVAT).toBe(100); // whole pounds, rounded down
});

const suffix = crypto.randomUUID().slice(0, 8);
const email = `pro-boundary-${suffix}@example.test`;
let orgId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie });
  const org = await auth.api.createOrganization({
    body: { name: `Pro boundary ${suffix}`, slug: `pro-boundary-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
});

afterAll(async () => {
  await dropOrganization(orgId);
  await dropUsers(email);
});

test("ownedAccount — true for this business's account, false for a stranger's id", async () => {
  const cashId = await ensureAccount(orgId, {
    code: "1000",
    name: "Cash",
    type: "asset",
  });
  expect(await ownedAccount(orgId, cashId)).toBe(true);
  expect(await ownedAccount(orgId, crypto.randomUUID())).toBe(false);
  expect(await ownedAccount(orgId, "not-a-uuid")).toBe(false);
});

test("ledgerRows — reads back what postJournalEntry wrote, scoped to the org", async () => {
  const cashId = await ensureAccount(orgId, {
    code: "1000",
    name: "Cash",
    type: "asset",
  });
  const incomeId = await ensureAccount(orgId, {
    code: "4000",
    name: "Sales",
    type: "income",
  });
  await postJournalEntry(
    orgId,
    "pro-boundary test sale",
    "test",
    [
      { accountId: cashId, debitCents: 500 },
      { accountId: incomeId, creditCents: 500 },
    ],
    new Date("2026-02-01T00:00:00Z"),
  );
  const rows = await ledgerRows(orgId);
  expect(rows.some((r) => r.code === "4000" && r.creditCents === 500)).toBe(
    true,
  );
});

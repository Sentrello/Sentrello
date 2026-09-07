import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, asc, db, eq, isNull, schema } from "@sentrello/db";
import { postJournalEntry } from "@sentrello/db/ledger";
import { record } from "@sentrello/db/security-events";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { ownedAccount } from "./chart";

type Rule = typeof schema.bankRules.$inferSelect;
type BankRow = typeof schema.bankTransactions.$inferSelect;

const MATCH_TYPES = ["contains", "starts", "equals"] as const;
const DIRECTIONS = ["any", "in", "out"] as const;

/**
 * Whether a rule claims a statement line.
 *
 * Comparison is case-insensitive and on trimmed text, because a bank sends
 * `ACME FUEL #4471` one month and `Acme Fuel  #4471` the next, and a rule that
 * stops working when a bank changes its capitalisation is a rule somebody has
 * to notice has stopped working.
 *
 * Exported so the preview and the applier cannot disagree about what a rule
 * does: the whole promise of showing somebody what a rule will match is that
 * it is the same answer as what it then matches.
 */
export function ruleMatches(rule: Rule, row: BankRow): boolean {
  if (!rule.enabled) return false;

  const text = (row.description ?? "").trim().toLowerCase();
  const needle = rule.matchText.trim().toLowerCase();
  // An empty rule would take everything, which is the accident this exists to
  // prevent rather than to permit.
  if (!needle) return false;
  const hit =
    rule.matchType === "equals"
      ? text === needle
      : rule.matchType === "starts"
        ? text.startsWith(needle)
        : text.includes(needle);
  if (!hit) return false;

  if (rule.direction === "in" && row.amountCents <= 0) return false;
  if (rule.direction === "out" && row.amountCents >= 0) return false;

  /**
   * The bounds are on the size, never on the sign.
   *
   * Money out is a negative number here, so a rule reading "up to $50" would
   * otherwise mean "anything below minus fifty dollars" and match the one
   * transaction it was written to exclude.
   */
  const size = Math.abs(row.amountCents);
  if (rule.minCents !== null && size < rule.minCents) return false;
  if (rule.maxCents !== null && size > rule.maxCents) return false;

  return true;
}

/**
 * Which lines a rule may look at in the first place.
 *
 * Never one somebody has already reconciled — the match they made is theirs.
 * Never one the bank still calls provisional, because the amount and the words
 * can both still change, and a rule that posts against a pending line posts a
 * figure the bank has not committed to.
 */
export function ruleEligible(row: BankRow): boolean {
  return !row.matchedEntryId && !row.pending;
}

/** The rules of a business, in the order they get to claim a line. */
async function rulesOf(organizationId: string): Promise<Rule[]> {
  return db
    .select()
    .from(schema.bankRules)
    .where(eq(schema.bankRules.organizationId, organizationId))
    .orderBy(asc(schema.bankRules.priority), asc(schema.bankRules.createdAt));
}

/**
 * Which bank account a line came out of.
 *
 * A feed stamps it on the row. A statement somebody uploaded may not have said,
 * and for the business with one bank account there is nothing to say — so the
 * only account is used, and where there are several the line is left alone
 * rather than guessed at. Money posted against the wrong bank account is a
 * reconciliation that can never be made to balance.
 */
async function bankSideOf(
  organizationId: string,
  row: BankRow,
): Promise<string | null> {
  if (row.bankAccountId) return row.bankAccountId;
  const banks = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, organizationId),
        eq(schema.accounts.isBank, true),
        isNull(schema.accounts.archivedAt),
      ),
    );
  return banks.length === 1 ? (banks[0]?.id ?? null) : null;
}

/**
 * Posting one line into the books against an account.
 *
 * Money out is an expense leaving the bank: debit the account the rule names,
 * credit the bank. Money in is the other way round. Both are the same two
 * lines every other posting in this module makes, through the same function,
 * so nothing here can put a figure in the ledger that the ledger would not
 * accept from anywhere else.
 */
export async function categorise(
  organizationId: string,
  row: BankRow,
  accountId: string,
  bankAccountId: string,
  source: string,
  memo: string,
): Promise<string> {
  const size = Math.abs(row.amountCents);
  const entry = await postJournalEntry(
    organizationId,
    memo,
    source,
    row.amountCents < 0
      ? [
          { accountId, debitCents: size },
          { accountId: bankAccountId, creditCents: size },
        ]
      : [
          { accountId: bankAccountId, debitCents: size },
          { accountId, creditCents: size },
        ],
    row.date,
  );

  await db
    .update(schema.bankTransactions)
    .set({ matchedEntryId: entry.id })
    .where(
      and(
        eq(schema.bankTransactions.id, row.id),
        eq(schema.bankTransactions.organizationId, organizationId),
        // Only while it is still unreconciled. Two syncs, or a person and a
        // job at the same moment, would otherwise both post the same line.
        isNull(schema.bankTransactions.matchedEntryId),
      ),
    );

  return entry.id;
}

export interface RuleRun {
  applied: number;
  skipped: number;
}

/**
 * Every rule, against everything still waiting.
 *
 * Runs after a sync and on request. A line is claimed by the first rule that
 * matches it, so ordering is the whole of the conflict resolution: two rules
 * that both fit are not an error, they are a business that has said which one
 * it prefers.
 *
 * A rule that cannot post — no bank account it can be sure of, a closed period,
 * an account somebody archived — leaves the line alone and counts as skipped.
 * The alternative is a job that dies halfway through a statement and leaves a
 * business's books half posted.
 */
export async function applyRules(organizationId: string): Promise<RuleRun> {
  // Not filtered for enabled here: `ruleMatches` answers that, and a second
  // copy of the rule is a second place for it to be wrong. The preview reads
  // the same function, which is what makes the two agree.
  const rules = await rulesOf(organizationId);
  if (rules.length === 0) return { applied: 0, skipped: 0 };

  const rows = await db
    .select()
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.organizationId, organizationId),
        isNull(schema.bankTransactions.matchedEntryId),
      ),
    );

  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!ruleEligible(row)) continue;
    const rule = rules.find((candidate) => ruleMatches(candidate, row));
    if (!rule) continue;

    const bankAccountId = await bankSideOf(organizationId, row);
    if (!bankAccountId) {
      skipped += 1;
      continue;
    }

    try {
      await categorise(
        organizationId,
        row,
        rule.accountId,
        bankAccountId,
        // Carries the rule's id, so a rule that turns out to be wrong can be
        // found and undone rather than hunted for line by line.
        `bank-rule:${rule.id}`,
        row.description ?? rule.name,
      );
      await db
        .update(schema.bankRules)
        .set({
          timesApplied: rule.timesApplied + applied + 1,
          lastAppliedAt: new Date(),
        })
        .where(eq(schema.bankRules.id, rule.id));
      applied += 1;
    } catch {
      // A closed period, or an account archived since the rule was written.
      // Neither is a reason to abandon the rest of the statement.
      skipped += 1;
    }
  }

  return { applied, skipped };
}

export function registerBankRules(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/bank-rules",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      return c.json({ rules: await rulesOf(orgId) });
    },
  );

  ctx.app.post(
    "/api/bank-rules",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const checked = await readRule(
        orgId,
        await c.req.json().catch(() => ({})),
      );
      if ("error" in checked) return c.json({ error: checked.error }, 400);

      const [rule] = await db
        .insert(schema.bankRules)
        .values({ organizationId: orgId, ...checked.rule })
        .returning();

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "bank.rule.changed",
        detail: { name: checked.rule.name, created: true },
      });

      return c.json({ rule }, 201);
    },
  );

  ctx.app.put(
    "/api/bank-rules/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      const checked = await readRule(
        orgId,
        await c.req.json().catch(() => ({})),
      );
      if ("error" in checked) return c.json({ error: checked.error }, 400);

      const [rule] = await db
        .update(schema.bankRules)
        .set(checked.rule)
        .where(
          and(
            eq(schema.bankRules.id, id),
            eq(schema.bankRules.organizationId, orgId),
          ),
        )
        .returning();
      if (!rule) return c.json({ error: "not found" }, 404);

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "bank.rule.changed",
        detail: { name: rule.name },
      });

      return c.json({ rule });
    },
  );

  ctx.app.delete(
    "/api/bank-rules/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["delete"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      const [gone] = await db
        .delete(schema.bankRules)
        .where(
          and(
            eq(schema.bankRules.id, id),
            eq(schema.bankRules.organizationId, orgId),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);

      /**
       * What it already posted stays posted.
       *
       * Deleting a rule stops it claiming anything else; it does not reach
       * back into the ledger. Entries it made are undone one at a time,
       * deliberately, through the route below.
       */
      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "bank.rule.changed",
        detail: { name: gone.name, deleted: true },
      });

      return c.json({ ok: true });
    },
  );

  /**
   * What this rule would take, before it takes anything.
   *
   * The one control that makes writing a rule safe for somebody who is not
   * sure what they are doing: a rule matching on "a" would otherwise post a
   * hundred entries before anybody saw a screen. Answers from the rule as
   * typed, not as saved, so it can be checked while it is being written.
   */
  ctx.app.post(
    "/api/bank-rules/preview",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const checked = await readRule(
        orgId,
        await c.req.json().catch(() => ({})),
      );
      if ("error" in checked) return c.json({ error: checked.error }, 400);

      const rows = await db
        .select()
        .from(schema.bankTransactions)
        .where(eq(schema.bankTransactions.organizationId, orgId));

      const asRule = {
        ...checked.rule,
        enabled: true,
        id: "",
        organizationId: orgId,
        timesApplied: 0,
        lastAppliedAt: null,
        createdAt: new Date(),
      } as Rule;

      const matched = rows.filter((row) => ruleMatches(asRule, row));
      return c.json({
        // Everything it would take now, and how much of that is already
        // reconciled and therefore out of reach — which is the difference
        // between "this rule does nothing" and "this rule is too late".
        matched: matched.length,
        wouldPost: matched.filter(ruleEligible).length,
        examples: matched.slice(0, 10).map((row) => ({
          id: row.id,
          date: row.date,
          description: row.description,
          amountCents: row.amountCents,
          reconciled: Boolean(row.matchedEntryId),
        })),
      });
    },
  );

  /**
   * Run them now, against what is already sitting there.
   *
   * `bookkeeping.update` rather than `create`: it is the same act as
   * confirming a match, which is the permission a bookkeeper is given to do
   * their job.
   */
  ctx.app.post(
    "/api/bank-rules/apply",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      return c.json(await applyRules(orgId));
    },
  );

  /**
   * Categorising one line by hand.
   *
   * The other half of rules, and the half that comes first: somebody looks at
   * a statement line, says which account it belongs in, and the books are up
   * to date. A rule is what stops them doing it again next month.
   */
  ctx.app.post(
    "/api/bank-transactions/:id/categorise",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const [row] = await db
        .select()
        .from(schema.bankTransactions)
        .where(
          and(
            eq(schema.bankTransactions.id, id),
            eq(schema.bankTransactions.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!row) return c.json({ error: "not found" }, 404);
      if (row.matchedEntryId) {
        return c.json({ error: "already reconciled" }, 409);
      }

      const accountId = String(body.accountId ?? "");
      if (!(await ownedAccount(orgId, accountId))) {
        return c.json({ error: "that is not an account of yours" }, 404);
      }

      const named = String(body.bankAccountId ?? "");
      if (named && !(await ownedAccount(orgId, named))) {
        return c.json({ error: "that is not an account of yours" }, 404);
      }
      const bankAccountId = named || (await bankSideOf(orgId, row));
      if (!bankAccountId) {
        return c.json(
          {
            error:
              "say which bank account this came out of — there is more than one",
          },
          400,
        );
      }
      if (bankAccountId === accountId) {
        // Both sides the same account is an entry that says nothing and
        // balances perfectly, so nothing downstream would ever question it.
        return c.json(
          { error: "a line cannot be posted against its own bank account" },
          400,
        );
      }

      const entryId = await categorise(
        orgId,
        row,
        accountId,
        bankAccountId,
        `bank-category:${row.id}`,
        row.description ?? "Categorised from the bank",
      );
      return c.json({ entryId }, 201);
    },
  );

  /**
   * Undoing one, when the rule was wrong.
   *
   * A rule applied to two hundred lines is two hundred entries, and the person
   * who has to fix that is the reason this exists. It reverses rather than
   * deletes, the same as everything else that touches the ledger, and it will
   * only undo what a rule or a categorisation posted — an entry behind an
   * invoice or a bill is somebody else's document and is voided through its
   * own screen, not from a statement line.
   */
  ctx.app.post(
    "/api/bank-transactions/:id/uncategorise",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";

      const [row] = await db
        .select()
        .from(schema.bankTransactions)
        .where(
          and(
            eq(schema.bankTransactions.id, id),
            eq(schema.bankTransactions.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!row?.matchedEntryId) return c.json({ error: "not found" }, 404);

      const [entry] = await db
        .select()
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.id, row.matchedEntryId),
            eq(schema.journalEntries.organizationId, orgId),
          ),
        )
        .limit(1);
      // No entry behind the link at all is the same answer as the wrong kind
      // of entry: this route does not undo it.
      if (!entry) return c.json({ error: "not found" }, 404);
      const source = entry.source ?? "";
      if (
        !source.startsWith("bank-rule:") &&
        !source.startsWith("bank-category:")
      ) {
        return c.json(
          {
            error:
              "that line was reconciled against an invoice or a bill, which is undone from its own screen",
          },
          409,
        );
      }

      const lines = await db
        .select()
        .from(schema.journalLines)
        .where(eq(schema.journalLines.entryId, entry.id));

      await postJournalEntry(
        orgId,
        `Reversal of ${entry.memo}`,
        `reversal:${entry.id}`,
        lines.map((line) => ({
          accountId: line.accountId,
          debitCents: line.creditCents,
          creditCents: line.debitCents,
        })),
      );

      await db
        .update(schema.bankTransactions)
        .set({ matchedEntryId: null })
        .where(
          and(
            eq(schema.bankTransactions.id, row.id),
            eq(schema.bankTransactions.organizationId, orgId),
          ),
        );

      return c.json({ ok: true });
    },
  );
}

interface DraftRule {
  name: string;
  matchType: string;
  matchText: string;
  direction: string;
  minCents: number | null;
  maxCents: number | null;
  accountId: string;
  priority: number;
  enabled: boolean;
}

/** A rule somebody typed, checked before it can touch anything. */
async function readRule(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ rule: DraftRule } | { error: string }> {
  const name = String(body.name ?? "")
    .trim()
    .slice(0, 100);
  if (!name) return { error: "give the rule a name" };

  const matchText = String(body.matchText ?? "")
    .trim()
    .slice(0, 200);
  if (!matchText) {
    // A rule with nothing to match on would claim every line on the statement.
    return { error: "say what the statement line has to say" };
  }

  const matchType = String(body.matchType ?? "contains");
  if (!MATCH_TYPES.includes(matchType as (typeof MATCH_TYPES)[number])) {
    return { error: "that is not a way of matching" };
  }

  const direction = String(body.direction ?? "any");
  if (!DIRECTIONS.includes(direction as (typeof DIRECTIONS)[number])) {
    return { error: "money in, money out, or either" };
  }

  const accountId = String(body.accountId ?? "");
  if (!(await ownedAccount(organizationId, accountId))) {
    return { error: "that is not an account of yours" };
  }

  const minCents = bound(body.minCents);
  const maxCents = bound(body.maxCents);
  if (minCents === "bad" || maxCents === "bad") {
    return { error: "the amounts have to be whole pennies" };
  }
  if (minCents !== null && maxCents !== null && minCents > maxCents) {
    // Silently matches nothing otherwise, which reads as a broken rule.
    return { error: "the smallest amount is larger than the largest" };
  }

  return {
    rule: {
      name,
      matchType,
      matchText,
      direction,
      minCents,
      maxCents,
      accountId,
      priority: Number.isInteger(body.priority) ? Number(body.priority) : 100,
      enabled: body.enabled !== false,
    },
  };
}

/** One end of an amount range: cents, or nothing. */
function bound(value: unknown): number | null | "bad" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return "bad";
  }
  return value;
}

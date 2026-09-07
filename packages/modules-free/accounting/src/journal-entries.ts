import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import { postJournalEntry } from "@sentrello/db/ledger";
import { record } from "@sentrello/db/security-events";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { ownedAccount } from "./chart";

/**
 * An entry posted by a person, which the journal had no way to accept.
 *
 * Every figure in the ledger arrived from something that happened — an invoice
 * issued, a bill paid, a card taken. That covers the year until the accountant
 * arrives and needs to record depreciation, accrue a bill that has not come
 * yet, move something posted to the wrong account, or write off a debt nobody
 * is going to pay. None of those is an event in the business; all of them are
 * decisions about how the books read, and no product calling itself an
 * accounting system can refuse them.
 *
 * It is also the most dangerous thing in this module: it writes to the ledger
 * directly, with no invoice or payment behind it to check the figure against.
 * So the rules are strict and none of them is a warning —
 *
 *  - it balances or it is refused, which `postJournalEntry` enforces for
 *    everything, not only this;
 *  - every account named must belong to this business;
 *  - a line is a debit **or** a credit, never both and never neither;
 *  - a closed period refuses it, the same as any other posting;
 *  - nothing is ever edited or deleted — a mistake is reversed, which is what
 *    an auditor expects to find and the only version that survives being
 *    checked.
 */
export function registerJournalEntries(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.post(
    "/api/journal/entries",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const memo = String(body.memo ?? "")
        .trim()
        .slice(0, 200);
      if (!memo) {
        // An unexplained entry is the one nobody can account for later, and
        // this is the kind of posting somebody will be asked about.
        return c.json({ error: "say what this entry is for" }, 400);
      }

      const checked = await readLines(orgId, body.lines);
      if ("error" in checked) return c.json({ error: checked.error }, 400);

      const postedAt = whenPosted(body.postedAt);
      if (postedAt === "bad") {
        return c.json({ error: "that is not a date" }, 400);
      }

      const entry = await postJournalEntry(
        orgId,
        memo,
        // Marked as somebody's own entry rather than something that happened,
        // so a report can tell the two apart and an auditor can find them.
        `manual:${crypto.randomUUID()}`,
        checked.lines,
        postedAt,
      );

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "journal.posted",
        detail: {
          memo,
          lines: checked.lines.length,
          // The size of it, which is what somebody scanning the log wants.
          totalCents: checked.total,
          postedAt: (postedAt ?? new Date()).toISOString(),
        },
      });

      return c.json({ entry }, 201);
    },
  );

  /**
   * Undoing one, by posting its mirror.
   *
   * Not a delete and not an edit. A ledger that can be changed after the fact
   * is a ledger nobody can rely on, and an accountant asked to explain a
   * figure needs to see both the mistake and the correction. This is also how
   * an accrual is meant to work: post it at the month end, reverse it on the
   * first of the next.
   */
  ctx.app.post(
    "/api/journal/entries/:id/reverse",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";

      const [original] = await db
        .select()
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.id, id),
            eq(schema.journalEntries.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!original) return c.json({ error: "not found" }, 404);

      /**
       * Once, however many times the button is pressed.
       *
       * Two reversals of one entry cancel the correction and leave the books
       * looking right while being wrong by the amount twice over — the sort of
       * error that is found in an audit rather than on a screen.
       */
      const [already] = await db
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.organizationId, orgId),
            eq(schema.journalEntries.source, `reversal:${original.id}`),
          ),
        )
        .limit(1);
      if (already) {
        return c.json({ error: "that entry has already been reversed" }, 409);
      }

      const lines = await db
        .select()
        .from(schema.journalLines)
        .where(eq(schema.journalLines.entryId, original.id));
      if (lines.length === 0) {
        return c.json({ error: "that entry has nothing on it" }, 400);
      }

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const postedAt = whenPosted(body.postedAt);
      if (postedAt === "bad") {
        return c.json({ error: "that is not a date" }, 400);
      }

      const reversed = await postJournalEntry(
        orgId,
        `Reversal of ${original.memo}`,
        // Carries the original's id, which is what makes a second reversal
        // detectable and what a report joins on to pair them up.
        `reversal:${original.id}`,
        // Debits become credits and credits become debits. Nothing else about
        // the entry changes, including which accounts it touched.
        lines.map((line) => ({
          accountId: line.accountId,
          debitCents: line.creditCents,
          creditCents: line.debitCents,
        })),
        postedAt,
      );

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "journal.reversed",
        detail: { of: original.id, memo: original.memo },
      });

      return c.json({ entry: reversed }, 201);
    },
  );
}

/** A date somebody typed, or nothing, or something that is not one. */
function whenPosted(value: unknown): Date | undefined | "bad" {
  if (value === undefined || value === null || value === "") return undefined;
  const at = new Date(String(value));
  return Number.isNaN(at.getTime()) ? "bad" : at;
}

interface CheckedLines {
  lines: { accountId: string; debitCents?: number; creditCents?: number }[];
  total: number;
}

/**
 * The lines, checked before anything is written.
 *
 * `postJournalEntry` refuses an unbalanced entry, which is the invariant that
 * matters — but it would refuse it with a message about debits and credits
 * after the accounts have been looked up. Everything here is a mistake a
 * person makes while typing, and each deserves to be told about in the terms
 * they typed it in.
 */
async function readLines(
  organizationId: string,
  input: unknown,
): Promise<CheckedLines | { error: string }> {
  if (!Array.isArray(input) || input.length < 2) {
    // One line cannot balance. Two is the smallest entry there is.
    return { error: "an entry needs at least two lines" };
  }
  if (input.length > 200) {
    return { error: "that is more lines than one entry should carry" };
  }

  const lines: CheckedLines["lines"] = [];
  let debits = 0;
  let credits = 0;

  for (const [index, raw] of input.entries()) {
    const row = raw as Record<string, unknown>;
    const at = `line ${index + 1}`;

    const accountId = typeof row.accountId === "string" ? row.accountId : "";
    if (!accountId || !(await ownedAccount(organizationId, accountId))) {
      // Named rather than "invalid input": the commonest mistake here is a
      // line somebody left half-filled, and they need to know which.
      return { error: `${at} does not name an account of yours` };
    }

    const debit = money(row.debitCents);
    const credit = money(row.creditCents);
    if (debit === "bad" || credit === "bad") {
      return { error: `${at} has an amount that is not whole pennies` };
    }
    if (debit > 0 && credit > 0) {
      return { error: `${at} is both a debit and a credit` };
    }
    if (debit === 0 && credit === 0) {
      return { error: `${at} has no amount on it` };
    }

    debits += debit;
    credits += credit;
    lines.push({
      accountId,
      ...(debit > 0 ? { debitCents: debit } : {}),
      ...(credit > 0 ? { creditCents: credit } : {}),
    });
  }

  if (debits !== credits) {
    /**
     * Said as a difference, because that is the question being asked.
     *
     * Somebody staring at an entry that will not post wants to know what it is
     * out by and in which direction — "debits 12000 != credits 11500" is the
     * same fact arranged so they have to do the subtraction.
     */
    const out = Math.abs(debits - credits);
    const side = debits > credits ? "debits" : "credits";
    return {
      error: `this does not balance: ${side} are over by ${(out / 100).toFixed(2)}`,
    };
  }

  return { lines, total: debits };
}

/** Integer cents, or nothing, or something that is neither. */
function money(value: unknown): number | "bad" {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return "bad";
  }
  return value;
}

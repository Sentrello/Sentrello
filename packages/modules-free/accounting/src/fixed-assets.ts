import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, asc, db, eq, isNull, like, schema } from "@sentrello/db";
import { postJournalEntry } from "@sentrello/db/ledger";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { ownedAccount } from "./chart";

type Asset = typeof schema.fixedAssets.$inferSelect;

/** One month's slice, and the month it belongs to. */
export interface Slice {
  month: Date;
  amountCents: number;
}

/**
 * The first day of the month a date falls in, in UTC.
 *
 * Everything here is keyed on a month rather than a date: depreciation is a
 * monthly slice, and comparing timestamps that differ by a few hours would
 * post one twice or skip one entirely depending on when the job happened to
 * run.
 */
export function monthOf(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0),
  );
}

function addMonths(month: Date, count: number): Date {
  return new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + count, 1),
  );
}

/**
 * Every slice this asset will ever produce, in order.
 *
 * A pure function of the asset's own terms, so the whole of the arithmetic can
 * be checked without a database, and so the screen showing somebody their
 * schedule and the job posting it are reading the same answer.
 *
 * **The slices add up to exactly the cost less the salvage.** That is the
 * property everything else depends on: an asset whose schedule is a penny out
 * leaves a balance sheet that never quite clears, and the error is invisible
 * until somebody disposes of it years later. Straight-line divides and puts
 * the remainder in the final month rather than spreading a fraction nobody can
 * represent; reducing balance takes whatever is left down to the salvage in
 * its last month, because a proportion of a proportion never reaches zero.
 */
export function depreciationSchedule(asset: {
  costCents: number;
  salvageCents: number;
  acquiredOn: Date;
  method: string;
  lifeMonths: number;
  rateBp: number | null;
}): Slice[] {
  const total = asset.costCents - asset.salvageCents;
  if (total <= 0 || asset.lifeMonths <= 0) return [];

  const first = monthOf(asset.acquiredOn);
  const slices: Slice[] = [];

  if (asset.method === "reducing-balance" && asset.rateBp) {
    let book = asset.costCents;
    let taken = 0;
    for (let i = 0; i < asset.lifeMonths; i += 1) {
      const last = i === asset.lifeMonths - 1;
      // A twelfth of the annual rate, on what the thing is still worth.
      const raw = Math.round((book * asset.rateBp) / 10_000 / 12);
      const amountCents = last
        ? total - taken
        : Math.max(0, Math.min(raw, total - taken));
      if (amountCents <= 0 && !last) continue;
      slices.push({ month: addMonths(first, i), amountCents });
      taken += amountCents;
      book -= amountCents;
    }
    return slices.filter((slice) => slice.amountCents > 0);
  }

  const base = Math.floor(total / asset.lifeMonths);
  let taken = 0;
  for (let i = 0; i < asset.lifeMonths; i += 1) {
    const last = i === asset.lifeMonths - 1;
    // The final month carries the remainder, so the schedule sums exactly.
    const amountCents = last ? total - taken : base;
    slices.push({ month: addMonths(first, i), amountCents });
    taken += amountCents;
  }
  return slices.filter((slice) => slice.amountCents > 0);
}

/** What has been taken so far, from the ledger rather than from a counter. */
async function takenSoFar(
  organizationId: string,
  asset: Asset,
): Promise<number> {
  const lines = await db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(
      and(
        eq(schema.journalEntries.organizationId, organizationId),
        eq(schema.journalLines.accountId, asset.accumulatedAccountId),
      ),
    );
  // The contra-asset is credited as depreciation is taken, so its balance is
  // credits less debits — a disposal debits it back out again.
  return lines.reduce(
    (sum, line) => sum + line.creditCents - line.debitCents,
    0,
  );
}

export interface DepreciationRun {
  posted: number;
  skipped: number;
}

/**
 * Everything due up to a month, posted.
 *
 * Catches up rather than only doing this month: a business that starts using
 * this in March for a van it bought in January is owed two months, and asking
 * somebody to post those by hand is asking them to get the arithmetic right
 * twice.
 *
 * A month already posted is never posted again — the check is on the entry's
 * own source, so it holds whether the job ran twice, the server restarted, or
 * somebody pressed the button while the job was running.
 */
export async function depreciate(
  organizationId: string,
  upTo: Date = new Date(),
): Promise<DepreciationRun> {
  const assets = await db
    .select()
    .from(schema.fixedAssets)
    .where(
      and(
        eq(schema.fixedAssets.organizationId, organizationId),
        // Nothing is depreciated after it has been sold; the disposal took
        // everything left on it.
        isNull(schema.fixedAssets.disposedOn),
      ),
    );

  const ceiling = monthOf(upTo);
  let posted = 0;
  let skipped = 0;

  for (const asset of assets) {
    const due = depreciationSchedule(asset).filter(
      (slice) => slice.month <= ceiling,
    );
    if (due.length === 0) continue;

    /**
     * Which months this asset has already had, read from the ledger.
     *
     * The entry's own source is the record — not a counter on the asset, which
     * would be a second thing to keep in step and would let a job that died
     * between the posting and the counter post the same month twice.
     */
    const already = new Set(
      (
        await db
          .select({ source: schema.journalEntries.source })
          .from(schema.journalEntries)
          .where(
            and(
              eq(schema.journalEntries.organizationId, organizationId),
              like(schema.journalEntries.source, `depreciation:${asset.id}:%`),
            ),
          )
      ).map((row) => row.source),
    );

    for (const slice of due) {
      const source = sourceOf(asset.id, slice.month);
      if (already.has(source)) continue;

      try {
        await postJournalEntry(
          organizationId,
          `Depreciation on ${asset.name}, ${slice.month.toISOString().slice(0, 7)}`,
          source,
          [
            {
              accountId: asset.expenseAccountId,
              debitCents: slice.amountCents,
            },
            {
              accountId: asset.accumulatedAccountId,
              creditCents: slice.amountCents,
            },
          ],
          // Dated in the month it belongs to, not the day the job ran: a
          // slice posted into the wrong month is a profit and loss that is
          // wrong in two periods at once.
          endOfMonth(slice.month),
        );
        posted += 1;
      } catch {
        // A closed period is the usual reason, and it is the right answer:
        // the month is shut and this one waits for somebody to decide.
        skipped += 1;
        continue;
      }

      await db
        .update(schema.fixedAssets)
        .set({ depreciatedThrough: slice.month })
        .where(eq(schema.fixedAssets.id, asset.id));
    }
  }

  return { posted, skipped };
}

/** The entry that says which asset and which month, so it happens once. */
function sourceOf(assetId: string, month: Date): string {
  return `depreciation:${assetId}:${month.toISOString().slice(0, 7)}`;
}

/** The last instant of a month, which is when its slice belongs. */
function endOfMonth(month: Date): Date {
  return new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0, 23, 59, 59),
  );
}

export function registerFixedAssets(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  /**
   * Monthly, on the first, early.
   *
   * Depreciation is a month's slice and there is nothing to do until a month
   * is over. Running on the first means the month that just ended is complete
   * before anything is posted for it.
   */
  ctx.registerJob({
    name: "depreciation",
    cron: "20 3 1 * *",
    handler: async () => {
      if (!ctx.entitled({ tier: "pro" })) return { skipped: "not entitled" };
      const organizations = await db
        .selectDistinct({ id: schema.fixedAssets.organizationId })
        .from(schema.fixedAssets);
      let posted = 0;
      for (const org of organizations) {
        // One business's closed period is not another's problem.
        const run = await depreciate(org.id);
        posted += run.posted;
      }
      return { posted };
    },
  });

  ctx.app.get(
    "/api/fixed-assets",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const assets = await db
        .select()
        .from(schema.fixedAssets)
        .where(eq(schema.fixedAssets.organizationId, orgId))
        .orderBy(asc(schema.fixedAssets.acquiredOn));

      /**
       * What each is worth now, which is the only figure anybody asks for.
       *
       * Read from the ledger rather than from the schedule: if somebody has
       * posted an adjusting entry against the accumulated account — and this
       * is exactly the account accountants adjust — the schedule is no longer
       * the truth and the books are.
       */
      const withValue = [];
      for (const asset of assets) {
        const taken = await takenSoFar(orgId, asset);
        withValue.push({
          ...asset,
          takenCents: taken,
          bookValueCents: asset.costCents - taken,
        });
      }
      return c.json({ assets: withValue });
    },
  );

  /**
   * What it will cost, month by month, before it is bought.
   *
   * The question somebody actually has — "what does this do to my profit and
   * loss" — answered from the same function that posts it.
   */
  ctx.app.post(
    "/api/fixed-assets/schedule",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const terms = readTerms(body);
      if ("error" in terms) return c.json({ error: terms.error }, 400);
      const slices = depreciationSchedule(terms.terms);
      return c.json({
        slices: slices.slice(0, 600),
        totalCents: slices.reduce((sum, slice) => sum + slice.amountCents, 0),
      });
    },
  );

  ctx.app.post(
    "/api/fixed-assets",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const name = String(body.name ?? "")
        .trim()
        .slice(0, 120);
      if (!name) return c.json({ error: "say what the asset is" }, 400);

      const terms = readTerms(body);
      if ("error" in terms) return c.json({ error: terms.error }, 400);

      const accounts = {
        assetAccountId: String(body.assetAccountId ?? ""),
        expenseAccountId: String(body.expenseAccountId ?? ""),
        accumulatedAccountId: String(body.accumulatedAccountId ?? ""),
      };
      for (const [field, id] of Object.entries(accounts)) {
        if (!(await ownedAccount(orgId, id))) {
          return c.json(
            { error: `${label(field)} is not an account of yours` },
            400,
          );
        }
      }
      if (new Set(Object.values(accounts)).size !== 3) {
        /**
         * Three different accounts, or the entry says nothing.
         *
         * The expense and the accumulated account being the same posts a debit
         * and a credit to one account: perfectly balanced, no effect, and no
         * depreciation ever appears anywhere. Nothing downstream can catch it
         * because the books add up.
         */
        return c.json(
          { error: "the three accounts have to be different from each other" },
          400,
        );
      }

      const [asset] = await db
        .insert(schema.fixedAssets)
        .values({
          organizationId: orgId,
          name,
          description: String(body.description ?? "").slice(0, 500) || null,
          ...terms.terms,
          ...accounts,
        })
        .returning();
      if (!asset) throw new Error("the asset was not written");

      /**
       * The purchase itself, only where the business has not already recorded
       * it.
       *
       * A van bought on a supplier's bill is already in the books, and posting
       * it again would put the van on the balance sheet twice. So this is
       * asked for rather than assumed, and it names where the money came from.
       */
      const paidFrom = String(body.paidFromAccountId ?? "");
      if (paidFrom) {
        if (!(await ownedAccount(orgId, paidFrom))) {
          return c.json({ error: "that is not an account of yours" }, 400);
        }
        await postJournalEntry(
          orgId,
          `Bought ${name}`,
          `asset-purchase:${asset.id}`,
          [
            { accountId: accounts.assetAccountId, debitCents: asset.costCents },
            { accountId: paidFrom, creditCents: asset.costCents },
          ],
          asset.acquiredOn,
        );
      }

      return c.json({ asset }, 201);
    },
  );

  /**
   * Catching up now, rather than waiting for the first of the month.
   *
   * `bookkeeping.update`: it posts what the schedule already committed the
   * business to, which is the same act as confirming a match rather than
   * deciding something new.
   */
  ctx.app.post(
    "/api/fixed-assets/depreciate",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      return c.json(await depreciate(orgId));
    },
  );

  /**
   * Selling it, scrapping it, or writing it off.
   *
   * Three things happen at once and all of them have to: the cost comes off
   * the balance sheet, everything depreciated so far comes off with it, and
   * whatever the difference is between what is left and what was received is a
   * gain or a loss this year. Getting this wrong leaves an asset the business
   * no longer owns sitting on its balance sheet forever, which is the commonest
   * thing wrong with a small business's books.
   */
  ctx.app.post(
    "/api/fixed-assets/:id/dispose",
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

      const [asset] = await db
        .select()
        .from(schema.fixedAssets)
        .where(
          and(
            eq(schema.fixedAssets.id, id),
            eq(schema.fixedAssets.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!asset) return c.json({ error: "not found" }, 404);
      if (asset.disposedOn) {
        return c.json({ error: "that asset has already gone" }, 409);
      }

      const proceeds = body.proceedsCents;
      if (
        typeof proceeds !== "number" ||
        !Number.isInteger(proceeds) ||
        proceeds < 0
      ) {
        return c.json({ error: "what it sold for, in whole pennies" }, 400);
      }

      const receivedInto = String(body.receivedIntoAccountId ?? "");
      if (proceeds > 0 && !(await ownedAccount(orgId, receivedInto))) {
        return c.json({ error: "say which account the money went into" }, 400);
      }

      const gainLossAccountId = String(body.gainLossAccountId ?? "");
      if (!(await ownedAccount(orgId, gainLossAccountId))) {
        return c.json(
          { error: "say where the gain or loss on it should go" },
          400,
        );
      }

      const taken = await takenSoFar(orgId, asset);
      const bookValue = asset.costCents - taken;
      const difference = proceeds - bookValue;

      const lines = [
        // Everything taken so far comes back off the contra-asset.
        ...(taken !== 0
          ? [{ accountId: asset.accumulatedAccountId, debitCents: taken }]
          : []),
        // And the cost comes off the asset itself.
        { accountId: asset.assetAccountId, creditCents: asset.costCents },
        ...(proceeds > 0
          ? [{ accountId: receivedInto, debitCents: proceeds }]
          : []),
        // Sold for more than it was worth is a gain, for less is a loss.
        ...(difference !== 0
          ? [
              difference > 0
                ? { accountId: gainLossAccountId, creditCents: difference }
                : { accountId: gainLossAccountId, debitCents: -difference },
            ]
          : []),
      ];

      const disposedOn = body.disposedOn
        ? new Date(String(body.disposedOn))
        : new Date();
      if (Number.isNaN(disposedOn.getTime())) {
        return c.json({ error: "that is not a date" }, 400);
      }

      const entry = await postJournalEntry(
        orgId,
        `Disposed of ${asset.name}`,
        `asset-disposal:${asset.id}`,
        lines,
        disposedOn,
      );

      await db
        .update(schema.fixedAssets)
        .set({ disposedOn, disposalProceedsCents: proceeds })
        .where(
          and(
            eq(schema.fixedAssets.id, asset.id),
            eq(schema.fixedAssets.organizationId, orgId),
          ),
        );

      return c.json({
        entryId: entry.id,
        bookValueCents: bookValue,
        // Named rather than signed, because "-4200" tells somebody nothing
        // about which way round it went.
        gainCents: difference > 0 ? difference : 0,
        lossCents: difference < 0 ? -difference : 0,
      });
    },
  );
}

const LABELS: Record<string, string> = {
  assetAccountId: "the asset account",
  expenseAccountId: "the depreciation account",
  accumulatedAccountId: "the accumulated depreciation account",
};

function label(field: string): string {
  return LABELS[field] ?? field;
}

interface Terms {
  costCents: number;
  salvageCents: number;
  acquiredOn: Date;
  method: string;
  lifeMonths: number;
  rateBp: number | null;
}

/** The terms of an asset, checked before anything is written or drawn. */
function readTerms(
  body: Record<string, unknown>,
): { terms: Terms } | { error: string } {
  const costCents = body.costCents;
  if (
    typeof costCents !== "number" ||
    !Number.isInteger(costCents) ||
    costCents <= 0
  ) {
    return { error: "what it cost, in whole pennies" };
  }

  const salvageCents =
    body.salvageCents === undefined || body.salvageCents === null
      ? 0
      : body.salvageCents;
  if (
    typeof salvageCents !== "number" ||
    !Number.isInteger(salvageCents) ||
    salvageCents < 0
  ) {
    return { error: "what it will be worth at the end, in whole pennies" };
  }
  if (salvageCents >= costCents) {
    // Nothing to depreciate, and a schedule of zeroes that looks like a bug.
    return { error: "it has to be worth less at the end than it cost" };
  }

  const acquiredOn = new Date(String(body.acquiredOn ?? ""));
  if (Number.isNaN(acquiredOn.getTime())) {
    return { error: "say when it was bought" };
  }

  const method = String(body.method ?? "straight-line");
  if (method !== "straight-line" && method !== "reducing-balance") {
    return { error: "straight line, or reducing balance" };
  }

  const lifeMonths = body.lifeMonths;
  if (
    typeof lifeMonths !== "number" ||
    !Number.isInteger(lifeMonths) ||
    lifeMonths < 1 ||
    lifeMonths > 1200
  ) {
    return { error: "how many months it lasts, between 1 and 1200" };
  }

  let rateBp: number | null = null;
  if (method === "reducing-balance") {
    const raw = body.rateBp;
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw >= 10_000
    ) {
      // Basis points, the same as every other rate in this module: 2500 is 25%
      // a year. A rate of 100% or more takes the whole thing in the first year
      // and is a typo rather than a policy.
      return { error: "the yearly rate in basis points, under 10000" };
    }
    rateBp = raw;
  }

  return {
    terms: { costCents, salvageCents, acquiredOn, method, lifeMonths, rateBp },
  };
}

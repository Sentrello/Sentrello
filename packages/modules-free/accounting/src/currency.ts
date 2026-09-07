import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, desc, eq, schema } from "@sentrello/db";
import {
  RATE_SCALE,
  baseCurrency,
  rateOn,
  toBaseCents,
} from "@sentrello/db/currency";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  exchangeAccount,
} from "@sentrello/db/ledger";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";

/** Re-exported so this module's callers keep their import. */
export { RATE_SCALE, baseCurrency, rateOn, toBaseCents };

/**
 * More than one currency, without the books becoming unreadable.
 *
 * A document may be raised in anything a customer or supplier uses. The ledger
 * is kept in exactly one currency, because a report that adds euros to dollars
 * is not a report — so every posting is converted on the way in, at the rate
 * that applied on the document's own date.
 *
 * Rates are stored rather than fetched. A rate has to be the one that applied
 * when the document was raised, not the one a service returns today, or last
 * year's accounts change every time somebody opens them.
 */

/**
 * The account exchange differences land in.
 *
 * Moved to `@sentrello/db/ledger` on 2026-08-24, because the sales side needs
 * it too: an invoice settled across a moving rate asks exactly the question a
 * bill being paid does, and it had no answer.
 */
export const EXCHANGE_ACCOUNT = CORE_ACCOUNTS.exchange;
export { exchangeAccount };

export function registerCurrency(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/accounting/currencies",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rates = await db
        .select()
        .from(schema.exchangeRates)
        .where(eq(schema.exchangeRates.organizationId, orgId))
        .orderBy(desc(schema.exchangeRates.asOf));
      return c.json({ baseCurrency: await baseCurrency(orgId), rates });
    },
  );

  /**
   * What the books are kept in.
   *
   * Changing it once there are postings is refused: the entries already in the
   * ledger were converted into the old one, and reinterpreting them as the new
   * one would silently restate every report the business has ever run.
   */
  ctx.app.put(
    "/api/accounting/currencies/base",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json().catch(() => ({}));
      const code = String(body.code ?? "")
        .trim()
        .toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        return c.json({ error: "a three-letter currency code" }, 400);
      }

      const [posted] = await db
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(eq(schema.journalEntries.organizationId, orgId))
        .limit(1);
      if (posted && code !== (await baseCurrency(orgId))) {
        return c.json(
          {
            error:
              "the books already have entries in the current currency — changing it would restate every one of them",
          },
          409,
        );
      }

      await db
        .update(schema.organizations)
        .set({ baseCurrency: code })
        .where(eq(schema.organizations.id, orgId));
      return c.json({ baseCurrency: code });
    },
  );

  /** Recording what a currency was worth on a day. */
  ctx.app.post(
    "/api/accounting/currencies",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json().catch(() => ({}));
      const code = String(body.code ?? "")
        .trim()
        .toUpperCase();
      const rateMicro = body.rateMicro;
      if (!/^[A-Z]{3}$/.test(code)) {
        return c.json({ error: "a three-letter currency code" }, 400);
      }
      if (code === (await baseCurrency(orgId))) {
        return c.json(
          { error: "the currency the books are kept in is always 1" },
          400,
        );
      }
      if (!Number.isInteger(rateMicro) || rateMicro <= 0) {
        return c.json(
          { error: "rateMicro must be a whole number of millionths" },
          400,
        );
      }
      const asOf = body.asOf ? new Date(body.asOf) : new Date();
      if (Number.isNaN(asOf.getTime())) {
        return c.json({ error: "unreadable date" }, 400);
      }

      const [row] = await db
        .insert(schema.exchangeRates)
        .values({ organizationId: orgId, code, rateMicro, asOf })
        .returning();
      return c.json({ rate: row }, 201);
    },
  );
}

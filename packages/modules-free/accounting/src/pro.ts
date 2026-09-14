import { defineMiddleware } from "@sentrello/module-sdk";
import type { ModuleContext } from "@sentrello/module-sdk";
import { registerCurrency } from "./currency";
import { registerAccountingCustomFields } from "./custom-fields";
import { registerDimensions } from "./dimensions";
import { registerJournalEntries } from "./journal-entries";
import { registerProReports } from "./pro-reports";
import { registerTaxes } from "./taxes";

/**
 * The half of Accounting a licence pays for.
 *
 * Shrinking: banking — accounts and transfers, feeds, rules, matching and
 * reconciliation — assets and periods — fixed assets, budgets, year-end
 * close — and payables — purchases and bills, vendor credits, bank payments
 * and payees, recurring bills, contractor tax — register from their own
 * commercial bundle now, and the groups below follow the same road. What
 * remains here is registered exactly as before.
 *
 * Registered on every instance and answered only on entitled ones — the same
 * arrangement the dashboard uses. The loader gates whole modules; Accounting is
 * a Free module that grows a second half, so the gate has to be here, and it
 * has to be checked per request because a licence can arrive or lapse while the
 * process is running.
 *
 * Everything behind it posts through the same ledger the Free half reads. A Pro
 * instance has more of the product, never a second set of books.
 */
export function registerPro(ctx: ModuleContext) {
  const proOnly = defineMiddleware(async (c, next) => {
    // 404 rather than 403: on a Free instance these endpoints do not exist,
    // which is what the module boot tests assert for anything gated.
    if (!ctx.entitled({ tier: "pro" })) return c.notFound();
    await next();
  });

  registerJournalEntries(ctx, proOnly);
  registerAccountingCustomFields(ctx, proOnly);
  registerDimensions(ctx, proOnly);
  registerTaxes(ctx, proOnly);
  registerCurrency(ctx, proOnly);
  registerProReports(ctx, proOnly);
}

import { defineMiddleware } from "@sentrello/module-sdk";
import type { ModuleContext } from "@sentrello/module-sdk";
import { registerBankFeeds } from "./bank-feeds";
import { registerBankPayments } from "./bank-payments";
import { registerBankRules } from "./bank-rules";
import { registerBanking } from "./banking";
import { registerBudgets } from "./budgets";
import { registerContractors } from "./contractors";
import { registerCurrency } from "./currency";
import { registerAccountingCustomFields } from "./custom-fields";
import { registerDimensions } from "./dimensions";
import { registerFixedAssets } from "./fixed-assets";
import { registerJournalEntries } from "./journal-entries";
import { registerProReports } from "./pro-reports";
import { registerPurchases } from "./purchases";
import { registerReconciliation } from "./reconciliation";
import { registerRecurringBills } from "./recurring-bills";
import { registerTaxes } from "./taxes";
import { registerVendorCredits } from "./vendor-credits";
import { registerYearEnd } from "./year-end";

/**
 * The half of Accounting a licence pays for.
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

  registerPurchases(ctx, proOnly);
  registerBanking(ctx, proOnly);
  registerBankFeeds(ctx, proOnly);
  registerJournalEntries(ctx, proOnly);
  registerBankRules(ctx, proOnly);
  registerFixedAssets(ctx, proOnly);
  registerReconciliation(ctx, proOnly);
  registerVendorCredits(ctx, proOnly);
  registerAccountingCustomFields(ctx, proOnly);
  registerDimensions(ctx, proOnly);
  registerYearEnd(ctx, proOnly);
  registerContractors(ctx, proOnly);
  registerBankPayments(ctx, proOnly);
  registerTaxes(ctx, proOnly);
  registerCurrency(ctx, proOnly);
  registerBudgets(ctx, proOnly);
  registerRecurringBills(ctx, proOnly);
  registerProReports(ctx, proOnly);
}

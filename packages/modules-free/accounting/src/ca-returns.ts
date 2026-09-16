import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { type CaReturns, caReturnsFor } from "@sentrello/db/ca-tax";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { periodFrom } from "./reports";

/**
 * The Canadian returns for a period, on one screen, computed from the
 * ledger the moment they are asked for — the same property the UK return
 * has, and for the same reason: a figure a business attests to has to be
 * the books' own answer, not a tally kept beside them.
 *
 * A business sees only the returns its tax rates call for. One rate for GST
 * gets the federal return and nothing else; a BC business gets that plus a
 * BC PST return; a Quebec business gets the federal figures and the QST
 * ones beside them, the way Revenu Québec's combined form presents them.
 * The machinery for filing in four provinces never appears in front of a
 * business that trades in one.
 */

/**
 * What the screen says under the figures — the limits and the obligations
 * the ledger cannot see, in words, because the reader is a person deciding
 * whether to copy these numbers onto a legal declaration. Every threshold
 * and form fact below was checked against the named source on
 * 15 September 2026; they change, so the date travels with them.
 */
export function caReturnNotes(out: CaReturns): string[] {
  const notes: string[] = [];

  if (out.gstHst) {
    notes.push(
      "GST/HST is computed on the accrual basis — tax counts when an invoice is issued, which is the CRA's collectible rule. Lines 110 (instalments paid), 111 (rebates), 205 (tax on taxable real property purchases) and 405 (other self-assessed GST/HST) are shown as zero because the ledger cannot know them; if any applies to you, account for it before filing. A negative line 109 is a refund position, claimed on line 114. Form lines per the CRA's GST/HST return guidance (canada.ca), checked 15 September 2026.",
      "One federal return covers GST and every harmonised province's HST — the provinces differ in the rate each sale carried, never in the form.",
    );
  }

  if (out.qst) {
    notes.push(
      "QST is a separate tax with its own net, administered by Revenu Québec — a Quebec business files GST and QST together on the combined FPZ-500-V, but the QST side never nets against the GST side. Input tax refunds (ITRs) are to QST what input tax credits are to GST. Form lines per revenuquebec.ca, checked 15 September 2026.",
    );
  }

  if (out.pst.length > 0) {
    notes.push(
      "PST and RST are filed to the province, separately from GST/HST, and recover nothing: tax paid on your own purchases is part of what they cost and never nets against what you collected. If you bought something taxable without paying the tax, the provinces require you to self-assess it — that figure is not computed here.",
      "The provinces pay small on-time filing commissions — British Columbia up to $198 a period, Manitoba 15% of the first $200 collected and 1% of the rest to a maximum of $58 — conditional on filing and paying by the due date, which is conduct this software cannot attest to. The figures here are before commission; take it on the form. Per gov.bc.ca (FIN 400 guide), gov.mb.ca (bulletin RST 004) and sets.saskatchewan.ca, checked 15 September 2026.",
    );
  }

  notes.push(
    "Which province's tax a sale should carry is decided by the place-of-supply rules, not by where you sit: goods take the province they are delivered to, and services generally take the customer's address (CRA technical bulletin B-103, checked 15 September 2026). These returns report the tax your documents actually charged; the right rate is chosen on the document.",
    "Beside each ledger figure is the same period's total from the tax bands frozen on your invoices and credit notes. The two agreeing is the check to run before filing; if they disagree, something was posted by hand or outside the documents, and it deserves a look first.",
  );
  return notes;
}

export function registerCaReturns(ctx: ModuleContext) {
  ctx.app.get(
    "/api/accounting/ca-returns",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const period = periodFrom((name) => c.req.query(name));
      const out = await caReturnsFor(orgId, period);
      return c.json({ ...out, notes: caReturnNotes(out) });
    },
  );
}

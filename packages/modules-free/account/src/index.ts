import { clientIp } from "@sentrello/auth";
import { db, schema } from "@sentrello/db";
import { contactByPortalToken } from "@sentrello/db/portal";
import type {
  EntitlementNeed,
  ModuleContext,
  RouteContext,
  SummaryFigure,
} from "@sentrello/module-sdk";
import {
  allAccountSections,
  defineModule,
  rateLimit,
} from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";

/**
 * The one page a business's customer reaches to see what they have with it.
 *
 * Shop has real accounts, Subscriptions has a mailed portal token, Booking
 * has a private link per booking, Invoicing has its own token portal — four
 * modules, four credentials, and somebody who buys often, washes their dog
 * weekly and is mid-training course has no single place that says so. This
 * page is that place; the sections themselves are `registerAccountSection`
 * in `@sentrello/module-sdk`, declared by whichever of those modules an
 * instance loaded.
 *
 * **Identity, and why this credential.** The viewer has no platform account —
 * they are the business's customer, not its staff — so `requireSession` does
 * not apply here any more than it does to `/portal/:token` or Subscriptions'
 * own portal, which this reuses rather than inventing a fourth mechanism:
 * `contactByPortalToken`, the same 32-byte link already minted for a CRM
 * contact and already trusted, alone, for accepting a quote and pausing a
 * subscription. It resolves to exactly one contact of exactly one
 * organization, constant-time compared, so the token *is* the scoping: there
 * is no `organizationId` to forge past it and no session to steal. Shop's own
 * password account is a second way in for its own storefront, out of scope
 * here — see this module's report to `Modules` for how it joins in.
 */

const LIMIT = 30;
const WINDOW_MS = 60_000;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] ?? ch,
  );

function figureText(f: SummaryFigure): string {
  if (f.kind === "money" && typeof f.value === "number") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: f.currency ?? "USD",
    }).format(f.value / 100);
  }
  return String(f.value);
}

export interface SectionView {
  id: string;
  label: string;
  icon: string | null;
  href: string | null;
  figures: SummaryFigure[];
}

/**
 * Every section this customer may be shown, and nothing else.
 *
 * The whole of the non-disclosure rule lives here, in the order the checks
 * run: a section whose entitlement the business lacks is dropped before
 * `hasAny` is ever called, and one this contact has nothing in is dropped
 * before `load` is. Neither a missing module nor an empty one leaves a trace
 * in the response — both look exactly like a section that does not exist.
 *
 * A section that throws is left out rather than taking the page with it, the
 * same choice the dashboard's widgets make: a customer's page should not go
 * blank because one module's query failed.
 */
export async function visibleSections(
  entitled: (need: EntitlementNeed) => boolean,
  organizationId: string,
  contactId: string,
): Promise<SectionView[]> {
  const views = await Promise.all(
    allAccountSections().map(async (section) => {
      if (section.entitlement && !entitled(section.entitlement)) return null;

      let present: boolean;
      try {
        present = await section.hasAny(organizationId, contactId);
      } catch (err) {
        console.error(`[account] ${section.id} hasAny failed`, err);
        return null;
      }
      if (!present) return null;

      // A caught `load` used to still return the section, empty figures and
      // all — a heading with nothing under it, which reads as broken rather
      // than absent. `hasAny` said there was something, `load` couldn't say
      // what, so the honest answer is the same as `hasAny` failing: leave it
      // out. `href` staying independently caught is deliberate — a section
      // with figures but no working link is still worth showing.
      let figures: SummaryFigure[];
      try {
        figures = await section.load(organizationId, contactId);
      } catch (err) {
        console.error(`[account] ${section.id} load failed`, err);
        return null;
      }
      const href = section.href
        ? await section.href(organizationId, contactId).catch(() => null)
        : null;

      return {
        id: section.id,
        label: section.label,
        icon: section.icon ?? null,
        href,
        figures,
      };
    }),
  );
  return views.filter((v): v is SectionView => v !== null);
}

const STYLE = `
:root{color-scheme:light dark;--ink:#1a1a1a;--muted:#666;--line:#e4e4e7;--bg:#fff}
@media (prefers-color-scheme: dark){:root{--ink:#f4f4f5;--muted:#a1a1aa;--line:#333;--bg:#131313}}
*{box-sizing:border-box}
body{font:16px/1.6 system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:3rem 1.5rem}
main{max-width:36rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .25rem}
.sub{color:var(--muted);margin:0 0 2rem}
section{border:1px solid var(--line);border-radius:.5rem;padding:1.25rem 1.5rem;margin-bottom:1rem}
h2{font-size:1.05rem;margin:0 0 .75rem}
.figures{display:flex;flex-wrap:wrap;gap:1.5rem}
.figure .label{color:var(--muted);font-size:.8125rem}
.figure .value{font-size:1.1rem;font-weight:600}
a.view{display:inline-block;margin-top:.75rem;font-size:.875rem}
`;

function accountPage(args: {
  businessName: string;
  customerName: string;
  sections: SectionView[];
}): string {
  const { businessName, customerName, sections } = args;
  const body =
    sections.length === 0
      ? `<p class="sub">Nothing here yet.</p>`
      : sections
          .map(
            (s) => `<section>
  <h2>${esc(s.label)}</h2>
  <div class="figures">${s.figures
    .map(
      (f) =>
        `<div class="figure"><div class="label">${esc(f.label)}</div><div class="value">${esc(figureText(f))}</div></div>`,
    )
    .join("")}</div>
  ${s.href ? `<a class="view" href="${esc(s.href)}">View</a>` : ""}
</section>`,
          )
          .join("\n");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(businessName)} — your account</title>
<style>${STYLE}</style>
</head><body><main>
<h1>${esc(businessName)}</h1>
<p class="sub">For ${esc(customerName)}</p>
${body}
<p class="sub" style="margin-top:2rem">This page is private to you. Anyone
with the link can see it, so treat it like a bill in the post.</p>
</main></body></html>`;
}

export default defineModule({
  id: "account",
  tier: "free",
  register(ctx: ModuleContext) {
    /**
     * No `requireSession`/`requirePermission` here — deliberately, as on
     * `/portal/:token` and Subscriptions' own portal. The caller is a
     * business's customer, never its staff, and the token is the whole
     * credential. Guessing is rate limited by address; a wrong token answers
     * 404 rather than 403, which is what an unknown URL looks like.
     */
    ctx.app.get("/account/:token", async (c: RouteContext) => {
      const limited = rateLimit(`account:${clientIp(c)}`, LIMIT, WINDOW_MS);
      if (!limited.allowed) {
        return c.text("Too many requests. Try again in a minute.", 429, {
          "retry-after": String(limited.retryAfterSeconds),
        });
      }

      const contact = await contactByPortalToken(c.req.param("token") ?? "");
      if (!contact) return c.notFound();

      const [org, sections] = await Promise.all([
        db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, contact.organizationId))
          .limit(1)
          .then((rows) => rows[0]),
        visibleSections(ctx.entitled, contact.organizationId, contact.id),
      ]);

      return c.html(
        accountPage({
          businessName: org?.name ?? "Your account",
          customerName: contact.name,
          sections,
        }),
      );
    });
  },
});

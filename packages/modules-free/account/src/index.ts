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
/*
 * Three states, not two: the customer's own choice, and the machine's when
 * they have not made one. A data-theme attribute on the root element is set
 * by the server from a cookie, so the page arrives in the right colours
 * rather than flashing the wrong ones first — and it works with JavaScript
 * off, which a link can and a script cannot.
 */
:root{color-scheme:light dark;--ink:#1a1a1a;--muted:#666;--line:#e4e4e7;--bg:#fff}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--ink:#f4f4f5;--muted:#a1a1aa;--line:#333;--bg:#131313}}
:root[data-theme="dark"]{color-scheme:dark;--ink:#f4f4f5;--muted:#a1a1aa;--line:#333;--bg:#131313}
:root[data-theme="light"]{color-scheme:light}
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
.actions{display:flex;gap:1rem;align-items:center;margin-top:.75rem;font-size:.875rem}
.tools{display:flex;justify-content:flex-end;gap:1rem;font-size:.8125rem;margin:-1.5rem 0 1.5rem}
.tools a{color:var(--muted)}

/* On paper, and in a PDF: no navigation, no links to things that are not
   there, and the ink in black where a printer will not waste colour on it. */
@media print{
  :root{--ink:#000;--muted:#333;--line:#bbb;--bg:#fff}
  body{padding:0}
  .tools,.actions,a.view{display:none}
  section{break-inside:avoid;border-color:#bbb}
}
`;

function accountPage(args: {
  businessName: string;
  customerName: string;
  sections: SectionView[];
  /** Their own link, so the page can offer its own tools. */
  token?: string;
  /** Their choice, when they have made one. */
  theme?: "light" | "dark";
  /** A page opened to be printed prints itself. */
  printing?: boolean;
}): string {
  const { businessName, customerName, sections, token, theme, printing } = args;
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
  <div class="actions">
    ${s.href ? `<a class="view" href="${esc(s.href)}">View</a>` : ""}
    ${
      token
        ? `<a href="/account/${esc(token)}/${esc(s.id)}/print">Save as PDF</a>`
        : ""
    }
  </div>
</section>`,
          )
          .join("\n");

  /*
   * The switch is a link, not a script.
   *
   * A customer's own choice, kept in a cookie and applied on the server, so
   * the page arrives in the right colours instead of flashing the wrong ones
   * — and so it works with JavaScript off, which is how a good many people
   * read a link that arrived by email.
   */
  const wanted = theme === "dark" ? "light" : "dark";
  const tools = token
    ? `<p class="tools">
  <a href="/account/${esc(token)}?theme=${wanted}">${wanted === "dark" ? "Dark" : "Light"}</a>
  <a href="/account/${esc(token)}/print">Save it all as PDF</a>
</p>`
    : "";

  return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${esc(theme)}"` : ""}><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(businessName)} — your account</title>
<style>${STYLE}</style>
</head><body><main>
<h1>${esc(businessName)}</h1>
<p class="sub">For ${esc(customerName)}</p>
${tools}
${body}
<p class="sub" style="margin-top:2rem">This page is private to you. Anyone
with the link can see it, so treat it like a bill in the post.</p>
</main>
${
  printing
    ? `<script>window.addEventListener("load", function () { window.print(); });</script>`
    : ""
}</body></html>`;
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
    /**
     * The page, and the two things a customer can do to it.
     *
     * `:section?` narrows it to one — theirs to keep, which is what "save as
     * PDF" means here: the browser's own print-to-PDF over a page written for
     * paper, rather than a rendering library in a bundle a customer's server
     * has to carry. `print` is the same page with the navigation gone and an
     * onload that opens the dialogue.
     */
    const draw = async (c: RouteContext, only?: string, printing = false) => {
      const limited = rateLimit(`account:${clientIp(c)}`, LIMIT, WINDOW_MS);
      if (!limited.allowed) {
        return c.text("Too many requests. Try again in a minute.", 429, {
          "retry-after": String(limited.retryAfterSeconds),
        });
      }

      const token = c.req.param("token") ?? "";
      const contact = await contactByPortalToken(token);
      if (!contact) return c.notFound();

      const [org, all] = await Promise.all([
        db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, contact.organizationId))
          .limit(1)
          .then((rows) => rows[0]),
        visibleSections(ctx.entitled, contact.organizationId, contact.id),
      ]);

      /*
       * A section they do not have is a 404, not an empty page.
       *
       * `visibleSections` has already applied every gate — entitlement, and
       * whether this customer has anything there at all — so filtering its
       * answer is the whole check. Naming a section that is not in it must
       * not confirm that it exists for somebody else.
       */
      const sections = only ? all.filter((s) => s.id === only) : all;
      if (only && sections.length === 0) return c.notFound();

      /*
       * Their choice of colours, kept in a cookie for a year.
       *
       * Set by a link rather than a script, so it works with JavaScript off,
       * and applied on the server so the page never arrives in the wrong
       * colours and then corrects itself. `SameSite=Lax` and `HttpOnly` —
       * nothing reads this but the server drawing the page.
       */
      const asked = c.req.query("theme");
      const chosen =
        asked === "dark" || asked === "light"
          ? asked
          : readTheme(c.req.header("cookie"));
      if (asked === "dark" || asked === "light") {
        c.header(
          "set-cookie",
          `sentrello_account_theme=${asked}; Path=/account; Max-Age=31536000; HttpOnly; SameSite=Lax`,
          { append: true },
        );
      }

      return c.html(
        accountPage({
          businessName: org?.name ?? "Your account",
          customerName: contact.name,
          sections,
          token,
          theme: chosen,
          printing,
        }),
      );
    };

    ctx.app.get("/account/:token", (c: RouteContext) => draw(c));
    ctx.app.get("/account/:token/print", (c: RouteContext) =>
      draw(c, undefined, true),
    );
    ctx.app.get("/account/:token/:section/print", (c: RouteContext) =>
      draw(c, c.req.param("section"), true),
    );
  },
});

/** The colours this customer chose last time, if they chose. */
function readTheme(cookie: string | undefined): "light" | "dark" | undefined {
  const found = /sentrello_account_theme=(light|dark)/.exec(cookie ?? "");
  return (found?.[1] as "light" | "dark" | undefined) ?? undefined;
}

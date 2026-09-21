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
  customerThemeFor,
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

/**
 * The glyphs this page draws, as paths.
 *
 * Inline rather than imported: this is a standalone HTML page served to
 * somebody with no account and no bundle, and a customer on a train should
 * not wait on a script to find out what a button does. Stroked, 24×24,
 * matching the platform's own set so a business's staff recognise them.
 */
const GLYPHS: Record<string, string> = {
  receipt:
    '<path d="M5 3v18l2-1.5L9 21l2-1.5L13 21l2-1.5L17 21l2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3 5 4.5Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  mail: '<path d="M3 6h18v12H3z"/><path d="m3 7 9 6 9-6"/>',
  "shopping-bag":
    '<path d="M4 7h16l-1.2 13H5.2L4 7Z"/><path d="M8.5 7V5.5a3.5 3.5 0 0 1 7 0V7"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/>',
  clipboard:
    '<path d="M9 4h6v3H9z"/><path d="M15 5.5h2A1.5 1.5 0 0 1 18.5 7v12A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V7A1.5 1.5 0 0 1 7 5.5h2"/><path d="M8.5 11h7M8.5 15h4"/>',
  calendar:
    '<path d="M4 6.5h16v14H4z"/><path d="M4 10.5h16M8.5 4v4M15.5 4v4"/>',
  /** The default, for a module whose icon this page does not know. */
  dot: '<circle cx="12" cy="12" r="7"/>',
  view: '<path d="M4 12h14"/><path d="m13 7 5 5-5 5"/>',
  pdf: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  back: '<path d="M20 12H6"/><path d="m11 7-5 5 5 5"/>',
};

/** One glyph, with the words a screen reader and a tooltip both need. */
function glyph(name: string, label?: string): string {
  const paths = GLYPHS[name] ?? GLYPHS.dot;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>${
    label ? `<span class="sr-only">${esc(label)}</span>` : ""
  }`;
}

const STYLE = `
/*
 * Three states, not two: the customer's own choice, and the machine's when
 * they have not made one. A data-theme attribute on the root element is set
 * by the server from a cookie, so the page arrives in the right colours
 * rather than flashing the wrong ones first — and it works with JavaScript
 * off, which a link can and a script cannot.
 */
:root{
  color-scheme:light dark;
  --ink:#18181b;--muted:#71717a;--line:#e4e4e7;--bg:#fafafa;--card:#fff;
  --accent:#2563eb;--shadow:0 1px 2px rgb(0 0 0 / .05), 0 8px 24px -16px rgb(0 0 0 / .25);
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --ink:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--bg:#0c0c0d;--card:#161618;
  --accent:#7aa2ff;--shadow:0 1px 2px rgb(0 0 0 / .4), 0 8px 24px -16px rgb(0 0 0 / .8);
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --ink:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--bg:#0c0c0d;--card:#161618;
  --accent:#7aa2ff;--shadow:0 1px 2px rgb(0 0 0 / .4), 0 8px 24px -16px rgb(0 0 0 / .8);
}
:root[data-theme="light"]{color-scheme:light}
*{box-sizing:border-box}
body{
  font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--ink);background:var(--bg);margin:0;padding:2.5rem 1.25rem 4rem;
  -webkit-font-smoothing:antialiased;
}
main{max-width:44rem;margin:0 auto}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
svg{width:1.125rem;height:1.125rem;flex:none}

/* The top: who this is, and the two things that act on the whole page. */
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:2rem}
h1{font-size:1.5rem;line-height:1.2;margin:0 0 .2rem;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0}
.tools{display:flex;gap:.5rem;flex:none}
.icon-button{
  display:inline-flex;align-items:center;justify-content:center;
  width:2.25rem;height:2.25rem;border:1px solid var(--line);border-radius:.6rem;
  color:var(--muted);background:var(--card);text-decoration:none;
}
.icon-button:hover{color:var(--ink);border-color:var(--muted)}

section{
  background:var(--card);border:1px solid var(--line);border-radius:.85rem;
  padding:1.25rem 1.4rem;margin-bottom:.9rem;box-shadow:var(--shadow);
}
.head{display:flex;align-items:center;gap:.6rem;margin-bottom:1rem}
.head svg{color:var(--accent)}
h2{font-size:1rem;font-weight:650;margin:0;letter-spacing:-.01em}
.figures{display:flex;flex-wrap:wrap;gap:1.25rem 2rem}
.figure .label{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
.figure .value{font-size:1.25rem;font-weight:650;letter-spacing:-.01em;line-height:1.3}
.figure .value.bad{color:#dc2626}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .figure .value.bad{color:#f87171}}
:root[data-theme="dark"] .figure .value.bad{color:#f87171}
.actions{display:flex;gap:.5rem;margin-top:1.1rem;padding-top:.9rem;border-top:1px solid var(--line)}
.foot{color:var(--muted);font-size:.8125rem;margin-top:2rem}

/* On paper, and in a PDF: no navigation, no links to things that are not
   there, and the ink in black where a printer will not waste colour on it. */
@media print{
  :root{--ink:#000;--muted:#3f3f46;--line:#bbb;--bg:#fff;--card:#fff;--accent:#000;--shadow:none}
  body{padding:0}
  .tools,.actions{display:none}
  section{break-inside:avoid;box-shadow:none}
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
  /** One section on its own, which needs a way back. */
  single?: boolean;
}): string {
  const {
    businessName,
    customerName,
    sections,
    token,
    theme,
    printing,
    single,
  } = args;

  const body =
    sections.length === 0
      ? `<p class="sub">Nothing here yet.</p>`
      : sections
          .map(
            (s) => `<section>
  <div class="head">${glyph(s.icon ?? "dot")}<h2>${esc(s.label)}</h2></div>
  <div class="figures">${s.figures
    .map(
      (f) =>
        `<div class="figure"><div class="label">${esc(f.label)}</div><div class="value${
          f.tone === "bad" ? " bad" : ""
        }">${esc(figureText(f))}</div></div>`,
    )
    .join("")}</div>
  ${
    s.href || token
      ? `<div class="actions">
    ${
      s.href
        ? `<a class="icon-button" href="${esc(s.href)}" title="Open ${esc(s.label)}">${glyph("view", `Open ${s.label}`)}</a>`
        : ""
    }
    ${
      token
        ? `<a class="icon-button" href="/account/${esc(token)}/${esc(s.id)}/print" title="Save ${esc(s.label)} as a PDF">${glyph("pdf", `Save ${s.label} as a PDF`)}</a>`
        : ""
    }
  </div>`
      : ""
  }
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
    ? `<div class="tools">
  ${
    single
      ? `<a class="icon-button" href="/account/${esc(token)}" title="Back to everything you have with us">${glyph("back", "Back to everything you have with us")}</a>`
      : ""
  }
  <a class="icon-button" href="/account/${esc(token)}?theme=${wanted}" title="${wanted === "dark" ? "Switch to dark" : "Switch to light"}">${glyph(
    wanted === "dark" ? "moon" : "sun",
    wanted === "dark" ? "Switch to dark" : "Switch to light",
  )}</a>
  <a class="icon-button" href="/account/${esc(token)}${single ? `/${esc(sections[0]?.id ?? "")}` : ""}/print" title="Save as a PDF">${glyph("pdf", "Save as a PDF")}</a>
</div>`
    : "";

  return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${esc(theme)}"` : ""}><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(businessName)} — your account</title>
<style>${STYLE}</style>
</head><body><main>
<div class="top">
  <div>
    <h1>${esc(businessName)}</h1>
    <p class="sub">For ${esc(customerName)}</p>
  </div>
  ${tools}
</div>
${body}
<p class="foot">This page is private to you. Anyone with the link can see it,
so treat it like a bill in the post.</p>
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
       * Their choice of colours — one cookie for every page they meet.
       *
       * It was this module's own, on `Path=/account`, which meant a customer
       * who chose dark here met a white invoice one click later. The helper
       * in the SDK is shared with the pages this one links to, so the choice
       * survives the walk between them.
       */
      const { theme: chosen, setCookie } = customerThemeFor({
        query: (name) => c.req.query(name),
        header: (name) => c.req.header(name),
      });
      if (setCookie) c.header("set-cookie", setCookie, { append: true });

      return c.html(
        accountPage({
          businessName: org?.name ?? "Your account",
          customerName: contact.name,
          sections,
          token,
          theme: chosen,
          printing,
          single: Boolean(only),
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

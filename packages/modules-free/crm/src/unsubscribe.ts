import { clientIp } from "@sentrello/auth";
import { db, eq, schema } from "@sentrello/db";
import { type Credit, creditFooter, creditFor } from "@sentrello/db/credit";
import { deadLinkPage } from "@sentrello/db/portal";
import {
  contactForUnsubscribeToken,
  unsubscribeContact,
} from "@sentrello/db/unsubscribe";
import {
  CUSTOMER_THEME_CSS,
  MARKETING_OPT_OUT,
  type MarketingOptOut,
  type ModuleContext,
  type RouteContext,
  customerThemeFor,
  hasService,
  moduleService,
  publicBodyLimit,
  rateLimit,
  themeAttribute,
} from "@sentrello/module-sdk";
import { html } from "./forms-reply";

/**
 * The link at the foot of a marketing email, for a contact.
 *
 * GET draws a page with one button and changes nothing, because mail scanners
 * open every link in a message before the person does — an unsubscribe on GET
 * is one a virus scanner pressed. POST does it, and takes both the page's own
 * form and a mail provider's one-click (RFC 8058), which arrives with no
 * cookies and no Origin. The signed token in the path is the whole authority.
 *
 * Never shut by putting a module away: this belongs to the person the mail
 * was sent to, not to the module that sent it.
 */

const LIMIT = 30;
const WINDOW_MS = 60_000;

const STYLE = `${CUSTOMER_THEME_CSS}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;
  font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:32rem}
h1{margin:0 0 .5rem;font-size:1.375rem}
p{margin:0 0 1rem;color:var(--muted)}
button{font:inherit;padding:.6rem 1rem;border-radius:.6rem;border:1px solid var(--line);
  background:var(--ink);color:var(--bg);cursor:pointer}
.credit{margin-top:2rem;font-size:.8125rem}
.credit a{color:var(--muted)}`;

function page(
  title: string,
  body: string,
  credit: Credit | null,
  theme?: "light" | "dark",
): string {
  return `<!doctype html>
<html lang="en"${themeAttribute(theme)}><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${html(title)}</title>
<style>${STYLE}</style>
</head><body><main>${body}${creditFooter(credit)}</main></body></html>`;
}

const HEADERS = {
  "x-robots-tag": "noindex",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
};

async function businessName(orgId: string): Promise<string> {
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  return org?.name ?? "This business";
}

export function registerUnsubscribe(ctx: ModuleContext): void {
  ctx.app.use("/unsubscribe/*", publicBodyLimit());

  const limited = (c: RouteContext) => {
    const hit = rateLimit(`unsubscribe:${clientIp(c)}`, LIMIT, WINDOW_MS);
    return hit.allowed
      ? null
      : c.text("Too many requests. Try again in a minute.", 429, {
          "retry-after": String(hit.retryAfterSeconds),
        });
  };

  const credit = (orgId: string) =>
    creditFor(orgId, ctx.entitled({ tier: "pro" }));

  ctx.app.get("/unsubscribe/:token", async (c) => {
    const refused = limited(c);
    if (refused) return refused;
    const token = c.req.param("token");
    const contact = await contactForUnsubscribeToken(token);
    if (!contact) return c.html(deadLinkPage(), 404, HEADERS);

    const { theme, setCookie } = customerThemeFor({
      query: (name) => c.req.query(name),
      header: (name) => c.req.header(name),
    });
    if (setCookie) c.header("set-cookie", setCookie, { append: true });

    const name = await businessName(contact.organizationId);
    const business = html(name);
    const who = html(contact.email ?? contact.name);
    const body = contact.hasNewsletter
      ? `<h1>${business}</h1>
<p>No more marketing email to ${who}. Bills, receipts and replies to you still arrive.</p>
<form method="post" action="/unsubscribe/${html(token)}">
<button type="submit">Stop marketing email to ${who}</button>
</form>`
      : `<h1>${business}</h1>
<p>${who} is already unsubscribed. No marketing email will be sent.</p>`;
    return c.html(
      page(
        `Unsubscribe — ${name}`,
        body,
        await credit(contact.organizationId),
        theme,
      ),
      200,
      HEADERS,
    );
  });

  ctx.app.post("/unsubscribe/:token", async (c) => {
    const refused = limited(c);
    if (refused) return refused;
    const contact = await contactForUnsubscribeToken(c.req.param("token"));
    if (!contact) return c.html(deadLinkPage(), 404, HEADERS);

    // A mail provider's one-click says so in the body; the page's form says
    // nothing. Either way the signed link is what is trusted.
    const form = await c.req.parseBody().catch(() => ({}));
    const oneClick =
      (form as Record<string, unknown>)["List-Unsubscribe"] === "One-Click";
    const evidence = {
      page: "/unsubscribe",
      method: oneClick ? "one-click" : "page",
    };
    await unsubscribeContact(contact, evidence);
    // And every list a module keeps of its own, or the page below is untrue
    // the next time a campaign goes out. Asked every time, not only when the
    // tick changed: the tick can be off while a subscription is still live.
    if (hasService(MARKETING_OPT_OUT)) {
      await moduleService<MarketingOptOut>(MARKETING_OPT_OUT)(
        contact.organizationId,
        { contactId: contact.id, email: contact.email },
        evidence,
      );
    }

    // In the colours the page before it was drawn in.
    const { theme } = customerThemeFor({
      query: (name) => c.req.query(name),
      header: (name) => c.req.header(name),
    });
    const business = await businessName(contact.organizationId);
    return c.html(
      page(
        `Unsubscribed — ${business}`,
        `<h1>Done</h1>
<p>${html(business)} will send no more marketing email to ${html(contact.email ?? contact.name)}.</p>`,
        await credit(contact.organizationId),
        theme,
      ),
      200,
      HEADERS,
    );
  });
}

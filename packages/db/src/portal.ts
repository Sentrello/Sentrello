import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";

/**
 * Customer portal tokens.
 *
 * This lives in `db` rather than in the invoicing module because two things
 * need it — the free module that renders the customer's page, and the Pro
 * module that lets them pay from it — and a commercial bundle may only depend
 * on the small set of packages the container links in. Importing a free
 * module's internals from a bundle resolves in development and fails inside
 * the container, which takes the whole bundle down with it.
 */

/** 32 random bytes, URL-safe: the link is the whole credential. */
export function newPortalToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Constant time: a token check that leaks timing is not a check. */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/** The customer a portal token belongs to, or null. */
export async function contactByPortalToken(token: string) {
  if (token.length < 20) return null;
  const candidates = await db
    .select()
    .from(schema.contacts)
    .where(isNotNull(schema.contacts.portalToken));
  return (
    candidates.find((row) => tokenMatches(token, row.portalToken ?? "")) ?? null
  );
}

/** The customer's token, minted on first need. `rotate` revokes the old one. */
export async function ensurePortalToken(
  contact: { id: string; portalToken: string | null },
  rotate = false,
): Promise<string> {
  if (contact.portalToken && !rotate) return contact.portalToken;
  const token = newPortalToken();
  await db
    .update(schema.contacts)
    .set({ portalToken: token })
    .where(and(eq(schema.contacts.id, contact.id)));
  return token;
}

/**
 * The seller's own details, for a document a customer keeps.
 *
 * Lives beside the portal helpers rather than in a module because four places
 * send customer-facing mail — the free invoicing module, the overdue job, and
 * Pro's receipts — and a bundle may only import the small set of packages the
 * container links in. One reader means an invoice email and the portal page
 * cannot disagree about who the business is.
 */
export async function businessIdentity(orgId: string) {
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);

  return {
    name: org?.name ?? "",
    address: org?.address,
    taxId: org?.taxId,
    taxIdLabel: org?.taxIdLabel,
    paymentInstructions: org?.paymentInstructions,
    /*
     * How this business writes a number, which is not how every business
     * does. `€1,279.97` is the American way of writing a European figure:
     * Germany reads `1.279,97 €` and France `1 279,97 €`, and a Canadian
     * invoicing in dollars was shown `CA$1,279.97` — the form you use when
     * you are *not* in Canada.
     *
     * The country is enough on its own, which is why this is a field rather
     * than a table of locales: `en-DE`, `en-FR`, `en-CA` all group and
     * punctuate the way those countries do. It is asked for on the business
     * settings screen, under the postcode, and is the second thing the
     * onboarding checklist sends somebody to fill in.
     */
    countryCode: org?.countryCode,
  };
}

/**
 * The locale a business's own figures are written in.
 *
 * The seller's convention, not the reader's: this is the seller's document,
 * and a German business's invoice is written the German way wherever it is
 * opened. `en-` rather than the country's own language because the language
 * decides the words and the region decides the numbers, and the words here
 * are already the business's own.
 *
 * Falls back to `en-US`, which is what everything did before this existed.
 * A country nobody filled in, or one typed as nonsense, is not a reason to
 * throw while drawing an invoice.
 */
export function moneyLocale(countryCode?: string | null): string {
  const region = (countryCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return "en-US";
  try {
    const locale = `en-${region}`;
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
    return locale;
  } catch {
    return "en-US";
  }
}

/**
 * Where a customer sees everything they have with one business.
 *
 * The page is `account/:token`, and the token is the contact's own — minted
 * for an invoice, a subscription or a booking, whichever came first. Null
 * when this contact has never been given one, or when the instance does not
 * know its own address: a link to nowhere is worse on a customer's page than
 * no link, because they will click it.
 *
 * Here rather than in a module because four modules wanted it and three of
 * them wrote it — the same twenty lines, three times, in three repositories.
 * A copy is a thing that drifts; this one had already started to, with one
 * copy minting a token and the others refusing to.
 */
export async function accountUrlFor(
  organizationId: string,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null;
  const base = process.env.SENTRELLO_BASE_URL;
  if (!base) return null;

  const [contact] = await db
    .select({ portalToken: schema.contacts.portalToken })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.id, contactId),
        eq(schema.contacts.organizationId, organizationId),
      ),
    )
    .limit(1);

  return contact?.portalToken
    ? `${base.replace(/\/$/, "")}/account/${contact.portalToken}`
    : null;
}

/**
 * What somebody sees when a customer link does not work.
 *
 * It used to be Hono's bare `404 Not Found`: no title, no sentence, no link,
 * on a page a customer reached by following a bill their supplier sent them.
 * A dead link is an ordinary thing — an email wraps a long URL and breaks it,
 * a token is replaced, a bookmark goes stale — and the person meeting it has
 * no idea whether they still owe money, whether the business exists, or what
 * to do next. A blank browser error is a bad answer to all three.
 *
 * Deliberately the same page for every bad token, and it names no business.
 * Which token was once real is not a customer's question and is not anybody
 * else's either: a different page for a token that used to work would tell a
 * stranger guessing at links when they had guessed close.
 *
 * Here rather than in the invoicing module for the reason at the top of this
 * file: the bill and the account page are drawn by two different modules and
 * both need it, and a commercial bundle may only depend on this package.
 */
export function deadLinkPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>This link does not work</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    padding:1.5rem; font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
    background:#faf9f7; color:#1a1a1a }
  main { max-width:32rem }
  h1 { margin:0 0 .5rem; font-size:1.375rem }
  p { margin:0; color:#555 }
  @media (prefers-color-scheme: dark) {
    body { background:#17181a; color:#ececec }
    p { color:#b4b4b4 }
  }
</style>
</head><body><main>
<h1>This link does not work</h1>
<p>It may have been replaced, or part of it lost on the way — an email will
break a long link when it wraps one. Ask whoever sent it for a new one.
Nothing has gone: the page is still there for the right link.</p>
</main></body></html>`;
}

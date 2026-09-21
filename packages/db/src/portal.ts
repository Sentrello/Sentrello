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
  };
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

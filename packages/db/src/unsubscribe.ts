import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { configuredBaseUrl } from "./base-url";
import { db } from "./client";
import { recordConsent } from "./consent";
import { isUuid } from "./index";
import * as schema from "./schema";

/**
 * Stopping marketing email to a contact, from a link in that email.
 *
 * The link has to work for somebody with no account, from any mail client,
 * years after it was sent, and it has to be impossible to guess one for
 * somebody else. A signed contact id does all four with no column to store:
 * the token is `<contactId>.<mac>`, the mac covers the organization as well,
 * and it is checked against the organization the contact actually belongs to.
 *
 * Its own key, derived from the instance secret, so this is never the key
 * credentials are sealed with. No secret, no links: a link that cannot be
 * checked is one anybody could forge.
 */

const PURPOSE = "marketing.email";

export interface UnsubscribeContact {
  id: string;
  organizationId: string;
  name: string;
  email: string | null;
  hasNewsletter: boolean;
}

function unsubscribeKey(): Buffer | null {
  const source =
    process.env.SENTRELLO_SECRET_KEY || process.env.BETTER_AUTH_SECRET || "";
  if (!source) return null;
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(source),
      Buffer.alloc(0),
      "sentrello:contact-unsubscribe",
      32,
    ),
  );
}

function mac(key: Buffer, orgId: string, contactId: string): string {
  return createHmac("sha256", key)
    .update(`${orgId}:${contactId}:${PURPOSE}`)
    .digest("base64url");
}

/** `<contactId>.<mac>`, or null on an instance with no secret. */
export function unsubscribeToken(
  orgId: string,
  contactId: string,
): string | null {
  const key = unsubscribeKey();
  return key ? `${contactId}.${mac(key, orgId, contactId)}` : null;
}

/**
 * The link to put in a marketing email, or null when this instance cannot
 * make one — no secret, or no address of its own.
 */
export function contactUnsubscribeUrl(
  orgId: string,
  contactId: string,
): string | null {
  const base = configuredBaseUrl();
  const token = unsubscribeToken(orgId, contactId);
  return base && token ? `${base}/unsubscribe/${token}` : null;
}

/** The contact a token names, if it is genuine. */
export async function contactForUnsubscribeToken(
  token: string,
): Promise<UnsubscribeContact | null> {
  const key = unsubscribeKey();
  if (!key) return null;
  const [contactId, supplied, extra] = token.split(".");
  if (!contactId || !supplied || extra !== undefined || !isUuid(contactId)) {
    return null;
  }

  const [contact] = await db
    .select({
      id: schema.contacts.id,
      organizationId: schema.contacts.organizationId,
      name: schema.contacts.name,
      email: schema.contacts.email,
      hasNewsletter: schema.contacts.hasNewsletter,
    })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId))
    .limit(1);
  if (!contact) return null;

  const expected = Buffer.from(mac(key, contact.organizationId, contact.id));
  const given = Buffer.from(supplied);
  if (expected.length !== given.length) return null;
  return timingSafeEqual(expected, given) ? contact : null;
}

/**
 * Take the tick off, write down that they asked, and tell staff.
 *
 * One transaction, so the tick and its evidence cannot disagree. Only the
 * request that actually changes the tick writes anything, so a second press —
 * or a mail provider's one-click arriving after the button — records nothing
 * twice. Returns whether this call was the one that changed it.
 */
export async function unsubscribeContact(
  contact: Pick<UnsubscribeContact, "id" | "organizationId" | "email" | "name">,
  evidence: Record<string, unknown>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    /*
     * Every record at the address, not only the one whose link was pressed.
     *
     * Two contacts share an address until somebody merges them, and the
     * request is the person's, not the row's: the other copy kept its tick, so
     * a list filtered on it, or an automation that found that one, went on
     * marketing to somebody who had said no.
     */
    const changed = await tx
      .update(schema.contacts)
      .set({ hasNewsletter: false })
      .where(
        and(
          eq(schema.contacts.organizationId, contact.organizationId),
          eq(schema.contacts.hasNewsletter, true),
          contact.email
            ? or(
                eq(schema.contacts.id, contact.id),
                sql`lower(${schema.contacts.email}) = lower(${contact.email})`,
              )
            : eq(schema.contacts.id, contact.id),
        ),
      )
      .returning({
        id: schema.contacts.id,
        name: schema.contacts.name,
        email: schema.contacts.email,
      });
    if (changed.length === 0) return false;

    for (const row of changed) {
      await recordConsent(
        {
          organizationId: contact.organizationId,
          subject: {
            kind: "contact",
            id: row.id,
            label: row.email ?? row.name,
          },
          purpose: PURPOSE,
          granted: false,
          source: "form",
          evidence,
        },
        tx,
      );
      await tx.insert(schema.activities).values({
        organizationId: contact.organizationId,
        contactId: row.id,
        type: "note",
        body: "Unsubscribed from marketing email",
        occurredAt: new Date(),
      });
    }
    return true;
  });
}

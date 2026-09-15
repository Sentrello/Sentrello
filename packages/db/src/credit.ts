import { eq } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";

/**
 * The "Powered by Sentrello" line at the foot of pages a visitor sees —
 * the sign-in screen, a form's thank-you page, anywhere a stranger lands.
 *
 * Lives in `db` rather than in a module for the same reason the portal
 * helpers do: the free modules render these pages, the commercial bundles
 * render more of them, and a bundle may only depend on the small set of
 * packages the container links in. One resolver means the sign-in page and a
 * shop's order confirmation cannot disagree about whose name is at the foot.
 *
 * The rules, which every surface shares:
 *
 * - **Free always shows ours.** That is part of what Free is, and for most
 *   people it is the only place they will ever see the product named.
 * - **Pro that has said nothing shows ours too.** The setting untouched is
 *   not a request for silence.
 * - **Pro can replace it** with its own line, or **remove it** by saving an
 *   empty one. Stored as `credit_text`: null is untouched, empty is removed,
 *   anything else is the business's own.
 * - **Doubt shows the branding.** A missing row, a failed query, an
 *   entitlement that cannot be resolved — every one of those renders ours,
 *   because no error may quietly take the credit off a Free instance's pages.
 */

export interface Credit {
  text: string;
  /** Where the line links, or plain text when null. */
  url: string | null;
}

/** The credit a Free instance always shows. */
export const SENTRELLO_CREDIT: Credit = {
  text: "Powered by Sentrello",
  url: "https://sentrello.com",
};

/**
 * The decision, separated from the query so it can be reasoned about — and
 * tested — without a database in the room.
 */
export function resolveCredit(
  row: { creditText: string | null; creditUrl: string | null } | undefined,
  isPro: boolean,
): Credit | null {
  if (!isPro) return SENTRELLO_CREDIT;
  // No row means the answer is unknown, and unknown shows the branding.
  if (!row) return SENTRELLO_CREDIT;
  // Untouched. A paying business that has said nothing is not asking for
  // nothing — removal is a choice, made by saving an empty line.
  if (row.creditText === null) return SENTRELLO_CREDIT;
  const text = row.creditText.trim();
  if (!text) return null;
  return { text, url: row.creditUrl?.trim() || null };
}

/** The credit one organization's public pages carry. */
export async function creditFor(
  orgId: string,
  isPro: boolean,
): Promise<Credit | null> {
  try {
    const [org] = await db
      .select({
        creditText: schema.organizations.creditText,
        creditUrl: schema.organizations.creditUrl,
      })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);
    return resolveCredit(org, isPro);
  } catch {
    // A database that cannot answer must not hide the branding.
    return SENTRELLO_CREDIT;
  }
}

/**
 * The credit for a page with nobody signed in — the sign-in screen itself.
 *
 * One organization per self-hosted instance today, so the instance's credit
 * is the first organization's. An unclaimed instance has none and shows ours.
 */
export async function instanceCredit(isPro: boolean): Promise<Credit | null> {
  try {
    const [org] = await db
      .select({
        creditText: schema.organizations.creditText,
        creditUrl: schema.organizations.creditUrl,
      })
      .from(schema.organizations)
      .orderBy(schema.organizations.createdAt)
      .limit(1);
    return resolveCredit(org, isPro);
  } catch {
    return SENTRELLO_CREDIT;
  }
}

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

/**
 * The line as markup, for server-rendered pages.
 *
 * Opens in a new tab: the visitor was in the middle of something — a
 * thank-you page is the receipt for it — and following the credit must not
 * take that away. The text is escaped here because it is typed by a business
 * and drawn on a page a stranger reads.
 */
export function creditFooter(credit: Credit | null): string {
  if (!credit || !credit.text.trim()) return "";
  const label = esc(credit.text.trim());
  const body = credit.url
    ? `<a href="${esc(credit.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
  return `<p class="credit">${body}</p>`;
}

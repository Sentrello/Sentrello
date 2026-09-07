import { and, desc, eq, inArray, not } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";

/**
 * Writing down who did what to whose account.
 *
 * Every action on the Users screen hands access around, and the only answer to
 * "who reset that password, and when" was previously somebody's memory. A
 * business with three people can shrug at that; one with fifteen, or one being
 * asked the question by an insurer, cannot.
 *
 * Names are copied alongside ids on purpose. The id is the truth, but a
 * removed member's name would otherwise resolve to nothing and the log would
 * read "somebody did something to somebody" exactly when it matters most.
 */

export type SecurityAction =
  | "role.changed"
  | "password.reset"
  | "two-factor.revoked"
  | "sessions.revoked"
  | "member.removed"
  | "member.invited"
  | "invitation.cancelled"
  | "group.created"
  | "group.changed"
  | "group.deleted"
  | "group.joined"
  | "group.left"
  | "policy.changed"
  | "session.revoked"
  | "sso.connected"
  | "sso.disconnected"
  | "sign-in.succeeded"
  | "sign-in.failed"
  | "account.unlocked"
  | "account.disabled"
  | "account.enabled"
  | "events.pruned"
  /**
   * A bank, connected or disconnected, and the details behind it changed.
   *
   * Not about a person, which is why these carry no subject — but they belong
   * in the same log for the same reason everything else here does: somebody
   * will one day need to know who connected a bank account to the books, and
   * when. Money leaving is the only thing more worth recording, and that goes
   * here too when it is built.
   */
  | "bank.connected"
  | "bank.disconnected"
  | "bank.credentials.changed"
  /**
   * An entry a person posted into the ledger, and one they reversed.
   *
   * The only writes to the books with no invoice, bill or payment behind them
   * to check the figure against — which is exactly why they are the ones worth
   * being able to look up by who and when.
   */
  | "journal.posted"
  | "journal.reversed"
  /**
   * A rule that categorises bank lines on its own.
   *
   * The only thing on the platform that writes to the ledger while nobody is
   * watching, so who changed one and when is worth being able to look up.
   */
  | "bank.rule.changed"
  /**
   * A month somebody signed off as agreed with the bank.
   *
   * The one act in the books that is a statement about the outside world
   * rather than about our own rows, and the one an accountant asks to see.
   */
  | "bank.reconciled"
  /**
   * A year drawn a line under, and a year opened up again.
   *
   * The two acts an accountant asks about by name, and the ones most worth
   * being able to say who did and when.
   */
  | "year.closed"
  | "year.reopened"
  /**
   * Somebody put a taxpayer number on file.
   *
   * For most sole traders a TIN is their social security number. Who handled
   * one and when is exactly what a business has to be able to answer later.
   */
  | "contractor.tax-id.set"
  /**
   * Money leaving the business, and who sent it.
   *
   * The only acts in the product that cannot be undone by pressing something
   * else, and the first three lines anybody reads after a bad afternoon.
   */
  | "payee.added"
  | "payee.removed"
  | "payment.sent"
  | "payment.scheduled"
  /**
   * Short links: claiming a hostname, and what is kept about visitors.
   *
   * A domain decides what this instance answers for; the privacy settings
   * decide what it holds about people who are not customers. Both are worth
   * being able to look up afterwards.
   */
  | "links.domain.claimed"
  | "links.domain.verified"
  | "links.tracking-key.issued"
  | "links.privacy.changed"
  | "links.forgotten"
  /**
   * A business's own search-data account, connected or removed.
   *
   * Which source the SEO module buys from decides who sees a business's
   * keywords and who is billed for them — both worth being able to look up.
   */
  | "seo.account.connected"
  | "seo.account.disconnected";

/** What each one says in a sentence, for the screen and for support. */
export const ACTION_TEXT: Record<SecurityAction, string> = {
  "role.changed": "changed the role of",
  "password.reset": "issued a new password for",
  "two-factor.revoked": "turned off two-factor for",
  "sessions.revoked": "signed out every device of",
  "member.removed": "removed",
  "member.invited": "invited",
  "invitation.cancelled": "withdrew the invitation to",
  "group.created": "created the group",
  "group.changed": "changed what is granted by",
  "group.deleted": "deleted the group",
  "group.joined": "added to a group",
  "group.left": "took out of a group",
  "policy.changed": "changed the sign-in rules for",
  "session.revoked": "signed out a device of",
  "bank.rule.changed": "changed a bank rule",
  "bank.reconciled": "finished a bank reconciliation",
  "payee.added": "added somebody to pay",
  "payee.removed": "removed somebody to pay",
  "payment.sent": "sent a payment from the bank",
  "payment.scheduled": "changed a repeating payment",
  "links.domain.claimed": "claimed a domain for short links",
  "links.domain.verified": "verified a domain for short links",
  "links.tracking-key.issued": "issued a link tracking key",
  "links.privacy.changed": "changed what is kept about link visitors",
  "links.forgotten": "erased an address from the link records",
  "seo.account.connected": "connected a search-data account",
  "seo.account.disconnected": "removed the search-data account",
  "contractor.tax-id.set": "recorded a contractor\u2019s taxpayer number",
  "year.closed": "closed the year",
  "year.reopened": "reopened a closed year",
  "journal.posted": "posted a journal entry",
  "journal.reversed": "reversed a journal entry",
  "bank.connected": "connected a bank",
  "bank.disconnected": "disconnected a bank",
  "bank.credentials.changed": "changed the bank provider details",
  "sso.connected": "connected sign-in for",
  "sso.disconnected": "disconnected sign-in for",
  "sign-in.succeeded": "signed in",
  "sign-in.failed": "failed to sign in as",
  "account.unlocked": "unlocked the account of",
  "account.disabled": "suspended",
  "account.enabled": "restored",
  // No trailing "for": this one is about the organization's whole log, not
  // about a person, so it is the only action here that never has a subject.
  // Phrased to end where the sentence ends, or the Events screen renders
  // "…retention period for —".
  "events.pruned": "removed history older than the retention period",
};

export async function record(input: {
  organizationId: string;
  /**
   * The person who did it, or null where there is nobody — a sign-in attempt
   * against an address that belongs to no account. Writing a name in that
   * case would be inventing one; null here is what keeps a failed attempt
   * against a stranger's address indistinguishable from one against a real
   * address with the wrong password, which is what stops the log itself from
   * revealing whether an address exists.
   */
  actor: { id: string; name?: string | null; email?: string | null } | null;
  subject?: { id?: string | null; name?: string | null; email?: string | null };
  action: SecurityAction;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const who = (person?: {
    name?: string | null;
    email?: string | null;
  }): string => person?.name?.trim() || person?.email?.trim() || "someone";

  // Never allowed to fail the action it describes. An administrator locked out
  // of their own instance because the log could not be written would be a
  // worse outcome than a gap in the log — and the gap is visible, which the
  // failure would not be.
  try {
    await db.insert(schema.securityEvents).values({
      organizationId: input.organizationId,
      actorId: input.actor?.id ?? null,
      actorName: input.actor ? who(input.actor) : null,
      subjectId: input.subject?.id ?? null,
      subjectName: input.subject ? who(input.subject) : null,
      action: input.action,
      detail: input.detail ?? null,
    });
  } catch (err) {
    console.error(
      `[users] could not record ${input.action}: ${(err as Error).message}`,
    );
  }
}

/**
 * The most recent changes, newest first.
 *
 * `exclude` is applied inside the query, ahead of `limit` — not as a filter
 * on the rows this returns. A card asking for the 25 most recent
 * *administrative* actions has to exclude sign-in noise from the window the
 * 25 are drawn from; filtering an already-limited page after the fact would
 * still lose an administrative row to twenty-five bot attempts that arrived
 * more recently, which is the exact bug this parameter exists to close (see
 * `packages/modules-free/users/src/people.ts`'s `GET /api/users`).
 */
export async function recent(
  organizationId: string,
  limit = 25,
  options?: { exclude?: SecurityAction[] },
) {
  const exclude = options?.exclude;
  return db
    .select()
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, organizationId),
        exclude?.length
          ? not(inArray(schema.securityEvents.action, exclude))
          : undefined,
      ),
    )
    .orderBy(desc(schema.securityEvents.at))
    .limit(limit);
}

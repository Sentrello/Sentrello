import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, not, sql } from "drizzle-orm";
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
  /*
   * The two a data-protection regulator asks to see.
   *
   * They belong in this log rather than one of their own: the same kind of
   * fact — somebody did something consequential to somebody else's data, here
   * is when and who — and a second audit trail is a second thing to forget to
   * read.
   */
  | "privacy.exported"
  | "privacy.erased"
  // Switching the safeguards off is the one worth having. It is either a
  // business that stopped being a covered entity, or somebody trying to make
  // an audit trail stop.
  | "hipaa.enabled"
  | "hipaa.disabled"
  // Somebody opened a record that may hold health information. §164.312(b).
  | "phi.read"
  /*
   * A VAT return is a declaration a named person made to a tax authority and
   * cannot withdraw. "Who filed this, and when" is the question afterwards, and
   * the receipt number is what HMRC asks for.
   */
  | "vat.filed"
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
  "hipaa.enabled": "turned on HIPAA safeguards",
  "hipaa.disabled": "turned off HIPAA safeguards",
  "phi.read": "opened a record holding health information",
  "vat.filed": "filed a VAT return to HMRC",
  "privacy.exported": "answered a request for their own data",
  "privacy.erased": "erased their personal data on request",
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
    /*
     * The id and the timestamp are chosen here rather than by the database,
     * because both go into the hash and a value the database picks after the
     * fact cannot be hashed before it is written.
     */
    const row = {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorId: input.actor?.id ?? null,
      actorName: input.actor ? who(input.actor) : null,
      subjectId: input.subject?.id ?? null,
      subjectName: input.subject ? who(input.subject) : null,
      action: input.action,
      detail: input.detail ?? null,
      at: new Date(),
    };

    const key = chainKey();
    if (!key) {
      // No key, no chain. The row is still written — a log with an
      // uncheckable entry beats an action nobody recorded — and `verifyChain`
      // says plainly that this instance cannot be checked at all.
      await db.insert(schema.securityEvents).values(row);
      return;
    }

    /*
     * One writer at a time, per organization.
     *
     * Two events recorded at once would otherwise read the same last row and
     * both claim to follow it, which forks the chain and reads afterwards as
     * exactly the tampering this is for. The lock is held for the transaction
     * and is per organization, so one busy business does not serialise
     * another's.
     */
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`security-events:${input.organizationId}`}))`,
      );
      const [last] = await tx
        .select({ hash: schema.securityEvents.hash })
        .from(schema.securityEvents)
        .where(eq(schema.securityEvents.organizationId, input.organizationId))
        .orderBy(desc(schema.securityEvents.at), desc(schema.securityEvents.id))
        .limit(1);
      const prevHash = last?.hash ?? null;
      await tx
        .insert(schema.securityEvents)
        .values({ ...row, prevHash, hash: linkOf(row, prevHash, key) });
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

/**
 * The safeguards for one organisation, cached briefly.
 *
 * Lives here rather than in the auth package because two callers need it — the
 * session guard, which runs on every authenticated request, and the read log
 * below, which runs whenever somebody opens a record. Two copies would be two
 * caches with two expiry times, and the one that went stale would be the one
 * holding a session open past its timeout.
 *
 * Ten seconds. Long enough to keep it off the hot path; short enough that a
 * safeguard cannot be silently absent for meaningfully longer than it takes to
 * switch on.
 */
const RULES_TTL_MS = 10_000;
const rulesCache = new Map<
  string,
  { at: number; rules: typeof schema.complianceSettings.$inferSelect | null }
>();

export async function hipaaRulesFor(
  organizationId: string,
): Promise<typeof schema.complianceSettings.$inferSelect | null> {
  const cached = rulesCache.get(organizationId);
  if (cached && Date.now() - cached.at < RULES_TTL_MS) return cached.rules;

  const [row] = await db
    .select()
    .from(schema.complianceSettings)
    .where(
      and(
        eq(schema.complianceSettings.organizationId, organizationId),
        eq(schema.complianceSettings.hipaa, true),
      ),
    )
    .limit(1);
  const rules = row ?? null;
  rulesCache.set(organizationId, { at: Date.now(), rules });
  return rules;
}

/** So switching the safeguards on from the screen takes effect at once. */
export function forgetHipaaRules(organizationId: string): void {
  rulesCache.delete(organizationId);
}

/**
 * Somebody opened a record that may hold health information. §164.312(b).
 *
 * The safeguard most systems lack. After a suspected snooping incident — a
 * receptionist looking up a neighbour, a member of staff reading a colleague's
 * notes — the question is "who opened this record", and a log of *changes*
 * cannot answer it because nothing was changed. That is the whole point: the
 * harm was the looking.
 *
 * Silent and free where the safeguards are off, which is almost everywhere. It
 * never throws: a record that could not be logged must still be readable,
 * because a clinician locked out of a patient's notes by an audit failure is a
 * worse outcome than a gap in the log — and the gap is visible.
 */
export async function recordRead(input: {
  organizationId: string;
  actor: { id: string; name?: string | null } | null;
  /** What was opened, in the words a person would use: "contact", "booking". */
  what: string;
  subject?: { id?: string | null; name?: string | null };
}): Promise<void> {
  try {
    const rules = await hipaaRulesFor(input.organizationId);
    if (!rules?.logReads) return;
    await record({
      organizationId: input.organizationId,
      actor: input.actor
        ? { id: input.actor.id, name: input.actor.name }
        : null,
      subject: input.subject,
      action: "phi.read",
      detail: { what: input.what },
    });
  } catch {
    // Deliberately swallowed. See above.
  }
}

/**
 * Making an edit to the log detectable.
 *
 * "Append-only from the application's side" was already true and was never
 * evidence of anything, because the application is not the only thing that can
 * reach the table. Anybody with SQL access could soften a role change, remove
 * a failed sign-in, or move a timestamp, and nothing anywhere would disagree.
 * That log is what HIPAA, SOC 2 and 800-171 are asking to see.
 *
 * Each row carries a keyed hash of its own contents and the hash of the row
 * before it, per organization. Change a row and its hash stops matching;
 * remove one and the next row's `prevHash` points at nothing.
 *
 * **Keyed, not a bare digest.** A plain SHA-256 chain is recomputable by
 * exactly the person who has just edited the row — they rewrite every hash
 * after it and the chain is whole again. An HMAC under the instance secret
 * means forging the chain needs the application's key as well as the database,
 * which is the difference between a determined attacker and a careless one.
 *
 * **What this does not do**, stated because a control believed to do more than
 * it does is worse than none:
 *
 * - **Deleting the newest rows leaves nothing behind.** A chain knows its
 *   links are intact; it does not know how long it should be. `verifyChain`
 *   returns the head hash so it can be written down somewhere the database
 *   cannot reach — an export, a monitoring check — which is what turns
 *   truncation into something detectable.
 * - **The secret plus database write access defeats it entirely.** Nothing
 *   short of writing to somewhere outside the instance would fix that, and
 *   this product's whole argument is that the data stays on the customer's
 *   machine.
 * - **Retention pruning breaks the front of the chain on purpose**, because it
 *   is supposed to remove old rows. Verification therefore starts at the
 *   oldest row still present and reports how far back it can see.
 */
function chainKey(): Buffer | null {
  const source =
    process.env.SENTRELLO_SECRET_KEY || process.env.BETTER_AUTH_SECRET || "";
  if (!source) return null;
  // Its own HKDF info string, so this key is not the one credentials are
  // sealed with. One purpose, one key.
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(source),
      Buffer.alloc(0),
      "sentrello:audit-chain",
      32,
    ),
  );
}

/**
 * What gets hashed: the row, in a fixed order, and the link before it.
 *
 * Field order is written out rather than taken from `Object.keys`, because a
 * hash whose input depends on key order is one that starts failing the day
 * somebody reorders a literal. `null` and `undefined` are distinguished, so a
 * detail that was absent cannot be edited into one that was explicitly empty.
 */
function chainInput(
  row: {
    id: string;
    organizationId: string;
    actorId: string | null;
    actorName: string | null;
    subjectId: string | null;
    subjectName: string | null;
    action: string;
    detail: Record<string, unknown> | null;
    at: Date;
  },
  prevHash: string | null,
): string {
  return JSON.stringify([
    prevHash,
    row.id,
    row.organizationId,
    row.actorId,
    row.actorName,
    row.subjectId,
    row.subjectName,
    row.action,
    // Stable regardless of how the object was built: a detail written as
    // `{b, a}` must hash the same as one written `{a, b}`, or a round trip
    // through anything that reorders keys reads as tampering.
    row.detail === null || row.detail === undefined
      ? null
      : stableJson(row.detail),
    row.at.toISOString(),
  ]);
}

/** JSON with object keys in sorted order, all the way down. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function linkOf(
  row: Parameters<typeof chainInput>[0],
  prevHash: string | null,
  key: Buffer,
): string {
  return createHmac("sha256", key)
    .update(chainInput(row, prevHash))
    .digest("base64url");
}

export interface ChainVerdict {
  /** False the moment anything does not line up. */
  intact: boolean;
  /** How many rows were checked, oldest still present to newest. */
  checked: number;
  /**
   * The newest row's hash, for writing down outside the database.
   *
   * A chain proves its own links; only an outside copy of this proves nothing
   * was cut off the end.
   */
  head: string | null;
  /** Rows written before the chain existed, or by an instance with no key. */
  unchained: number;
  /** In the words somebody reading a report would want them. */
  problems: string[];
}

/**
 * Walk one organization's log and say whether it has been edited.
 *
 * Oldest first, which is the order the chain was built in. Reads everything
 * rather than a page: this answers a question somebody asks occasionally and
 * expects to be true, not something on a screen's hot path.
 */
export async function verifyChain(
  organizationId: string,
): Promise<ChainVerdict> {
  const key = chainKey();
  const rows = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, organizationId))
    .orderBy(asc(schema.securityEvents.at), asc(schema.securityEvents.id));

  const problems: string[] = [];
  let checked = 0;
  let unchained = 0;
  let previous: { id: string; hash: string } | null = null;
  let head: string | null = null;

  if (!key) {
    return {
      intact: false,
      checked: 0,
      head: null,
      unchained: rows.length,
      problems: [
        "This instance has no secret key, so the log cannot be checked. Set SENTRELLO_SECRET_KEY, or check BETTER_AUTH_SECRET is present.",
      ],
    };
  }

  for (const row of rows) {
    if (!row.hash) {
      unchained += 1;
      // Not a problem in itself — every row written before this existed looks
      // like this — but it does end the chain, because the next row's link
      // points at a hash that was never computed.
      previous = null;
      continue;
    }

    const expected = linkOf(row, row.prevHash ?? null, key);
    if (expected !== row.hash) {
      problems.push(
        `The entry from ${row.at.toISOString()} (${row.action}) does not match its own record — it has been altered since it was written.`,
      );
    } else if (previous && row.prevHash !== previous.hash) {
      problems.push(
        `Something is missing before the entry from ${row.at.toISOString()} (${row.action}) — the entry it followed is no longer here.`,
      );
    }

    previous = { id: row.id, hash: row.hash };
    head = row.hash;
    checked += 1;
  }

  return {
    intact: problems.length === 0,
    checked,
    head,
    unchained,
    problems,
  };
}

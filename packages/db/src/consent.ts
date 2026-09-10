import { and, asc, eq } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";

/**
 * Proving somebody agreed, rather than asserting it.
 *
 * A boolean on a contact says what is true now. GDPR Article 7(1) puts the
 * burden of *demonstrating* consent on the business, Quebec's Law 25 asks for
 * the record to be kept, and the CCPA asks when an opt-out arrived. A tick is
 * not evidence of any of that.
 *
 * Both directions are recorded. Withdrawal is as much a fact worth proving as
 * consent: a business that cannot show when somebody unsubscribed cannot
 * defend the mail it sent the week before.
 */

/** What was agreed to. A short, stable key rather than a sentence. */
export type ConsentPurpose =
  | "marketing.email"
  | "data.sale"
  | "terms"
  | "privacy";

/** How the agreement reached us. */
export type ConsentSource = "form" | "staff" | "import" | "checkout" | "api";

export interface ConsentInput {
  organizationId: string;
  subject: {
    kind: "contact" | "subscriber" | "user";
    id: string;
    label?: string | null;
  };
  purpose: ConsentPurpose;
  granted: boolean;
  source: ConsentSource;
  /** Exactly what the person was shown, where anything was. */
  wording?: string | null;
  /** An address, a page, a confirmation click — whatever proves it. */
  evidence?: Record<string, unknown>;
  /** Who recorded it, where a member of staff did rather than the person. */
  actor?: { id: string; name?: string | null } | null;
  /** For an import, where the agreement genuinely happened earlier. */
  at?: Date;
}

/**
 * Write one down.
 *
 * **This one is allowed to fail the action it describes**, which is the
 * opposite of the audit log's rule, and deliberately so. A missing audit entry
 * is a visible gap; a missing consent record is invisible and leaves the
 * business asserting something it cannot show. Better to refuse the change
 * than to record a permission nobody can prove was given.
 *
 * Pass `tx` to write it in the same transaction as the state it describes, so
 * the tick and its evidence cannot disagree.
 */
export async function recordConsent(
  input: ConsentInput,
  tx: { insert: typeof db.insert } = db,
): Promise<void> {
  await tx.insert(schema.consentRecords).values({
    organizationId: input.organizationId,
    subjectKind: input.subject.kind,
    subjectId: input.subject.id,
    subjectLabel: input.subject.label?.trim() || null,
    purpose: input.purpose,
    granted: input.granted,
    source: input.source,
    wording: input.wording?.trim() || null,
    evidence: input.evidence ?? null,
    actorId: input.actor?.id ?? null,
    actorName: input.actor?.name?.trim() || null,
    ...(input.at ? { at: input.at } : {}),
  });
}

/**
 * Everything recorded about one person, oldest first.
 *
 * Oldest first because it is a history and reads as one — "agreed on the form,
 * withdrew two years later" is the sentence somebody needs, and newest-first
 * tells it backwards.
 */
export async function consentHistory(
  organizationId: string,
  subject: { kind: string; id: string },
): Promise<(typeof schema.consentRecords.$inferSelect)[]> {
  return db
    .select()
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.subjectKind, subject.kind),
        eq(schema.consentRecords.subjectId, subject.id),
      ),
    )
    .orderBy(asc(schema.consentRecords.at));
}

/** In the words a business would repeat to the person asking. */
export function describeConsent(
  row: typeof schema.consentRecords.$inferSelect,
): string {
  const what: Record<string, string> = {
    "marketing.email": "to be emailed marketing",
    "data.sale": "to their information being sold or shared",
    terms: "to the terms",
    privacy: "to the privacy notice",
  };
  const how: Record<string, string> = {
    form: "on a form they filled in",
    staff: "recorded by a member of staff",
    import: "brought in from a previous system",
    checkout: "at checkout",
    api: "through a connected system",
  };
  const subject = row.subjectLabel || "This person";
  const verb = row.granted ? "agreed" : "withdrew consent";
  const tail = row.granted ? (what[row.purpose] ?? row.purpose) : "";
  return [
    subject,
    verb,
    tail,
    how[row.source] ?? row.source,
    `on ${row.at.toISOString().slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join(" ");
}

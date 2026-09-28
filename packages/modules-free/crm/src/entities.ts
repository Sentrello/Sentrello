/**
 * What each CRM resource calls itself when it announces a change.
 *
 * Written down, one word per resource, rather than worked out from the URL.
 * It used to be worked out: the resource name with a trailing "s" taken off,
 * which is right for "contacts" and wrong for "companies" and "activities" —
 * and wrong silently. A company went onto the change feed as "companie" while
 * every subscription, every automation and every screen said "company", so a
 * business that asked to be told when a company changed was told nothing, for
 * ever. Not an error. Nothing at all.
 *
 * The rule that produced it would be wrong again the moment a module holds
 * addresses, categories, taxes or people, so the rule is gone. Both halves of
 * the conversation now read this map, which is the only way they cannot
 * disagree: subscribing to a word this does not contain is a type error, and
 * announcing a word nobody offers is impossible because nothing computes one.
 */
export const CRM_ENTITY = {
  contacts: "contact",
  companies: "company",
  activities: "activity",
  tasks: "task",
  tags: "tag",
  deals: "deal",
  notes: "note",
} as const;

/** A CRM resource, as the API spells it: "companies". */
export type CrmResource = keyof typeof CRM_ENTITY;

/** The word that resource announces itself by: "company". */
export type CrmEntity = (typeof CRM_ENTITY)[CrmResource];

/**
 * The resource a word belongs to, so a screen can say "companies" without
 * pluralising anything either. The same map read the other way round.
 */
export const CRM_RESOURCE = Object.fromEntries(
  Object.entries(CRM_ENTITY).map(([resource, entity]) => [entity, resource]),
) as Record<CrmEntity, CrmResource>;

/**
 * The records a webhook endpoint can ask to hear about.
 *
 * A deliberate subset — nobody has asked to be telephoned about a tag — but
 * every word in it is checked against what the feed actually announces, so a
 * subscription cannot name something that is never emitted. That is exactly
 * how "company" came to be offered while "companie" was being written, and the
 * only sign of it was an integration that silently never fired.
 *
 * Here rather than beside the delivery code because the settings screen offers
 * these and the server accepts them, and a list written twice is a list that
 * disagrees with itself. Nothing in this file imports anything, so the browser
 * can read it without pulling the database in behind it.
 */
export const WEBHOOK_ENTITIES = [
  "contact",
  "company",
  "deal",
] as const satisfies readonly CrmEntity[];

import { auth } from "@sentrello/auth";
import { and, db, eq, schema, sql } from "@sentrello/db";

/**
 * The access a business starts with.
 *
 * Learned from the reference, and from watching what actually happens: a business
 * that has to invent its own permission model before it can add its second
 * employee does not add its second employee. It gives everybody the owner's
 * role and hopes.
 *
 * So there are two default sets, and they answer two different questions.
 *
 * A **user policy** is how senior somebody is — an executive sees everything
 * and changes little; a manager runs the day; staff do the work. It is given
 * to a person directly.
 *
 * A **group policy** is what department somebody is in — Sales, Marketing,
 * Accounting, Customer Service. It arrives through a group, so moving somebody
 * between departments is moving them between groups and nothing else.
 *
 * Both are roles underneath, because that is what the permission checks
 * understand, and a person holds the union of their own and their groups'.
 * Both are data rather than code, which is the point: they can be edited and
 * deleted by the business that owns them.
 *
 * All of them, without exception. Staff and Accounting were once the odd ones
 * out: Better Auth reserves the names of the roles compiled into the product,
 * so those two refused to be stored as the business's own and could only be
 * copied. They are no longer compiled, so they are rows like the rest — a
 * business that wants a Staff who may also send invoices edits Staff, rather
 * than making a near-duplicate of it and remembering which one is assigned.
 *
 * Two names are still reserved and always will be: `admin`, which the instance
 * owner holds before any organization exists to hold a row, and `customer`,
 * which the portal assigns. Neither appears in this list.
 *
 * Role names are stored lower case — Better Auth normalises them — so
 * "Customer Service" is `customer service` in the table and is capitalised
 * again for reading.
 */

type Permissions = Record<string, string[]>;

export interface DefaultPolicy {
  /** As stored. Better Auth lower-cases role names, so these already are. */
  name: string;
  description: string;
  permission: Permissions;
}

/** Every role needs the landing page, or its holder signs in to nothing. */
const LANDS = { dashboard: ["read"] };

/** How senior somebody is. Given to a person. */
export const DEFAULT_USER_POLICIES: DefaultPolicy[] = [
  {
    name: "admins",
    description: "Everything, including settings and who else works here.",
    permission: {
      ...LANDS,
      docs: ["read", "create", "update", "delete"],
      crm: ["read", "create", "update", "delete"],
      invoicing: ["read", "create", "update", "delete", "send"],
      bookkeeping: ["read", "create", "update", "delete"],
      // Administrators can pay suppliers. Every other default role can see
      // that a payment happened and cannot make one.
      payments: ["read", "connect", "send"],
      reports: ["read"],
      settings: ["read", "update"],
      scheduling: ["read", "create", "update", "delete"],
      shop: ["read", "create", "update", "delete"],
      documents: ["read", "create", "update", "delete"],
      newsletter: ["read", "create", "update", "delete", "send"],
      links: ["read", "create", "update", "delete", "domains"],
      seo: ["read", "create", "update", "delete"],
    },
  },
  {
    /**
     * Sees everything, changes almost nothing.
     *
     * The role a business actually wants for an owner who is not the one doing
     * the work, and for an accountant's partner. Read on the money, because
     * looking at it is the whole reason for the account.
     */
    name: "executives",
    description: "Sees everything across the business, and changes little.",
    permission: {
      ...LANDS,
      docs: ["read"],
      crm: ["read"],
      invoicing: ["read"],
      bookkeeping: ["read"],
      reports: ["read"],
      settings: ["read"],
      scheduling: ["read"],
      shop: ["read"],
      documents: ["read"],
    },
  },
  {
    /**
     * Runs the day without being able to unmake it.
     *
     * Create and update widely; delete nowhere in the books. A manager who can
     * void an invoice can void the record of an argument they lost.
     */
    name: "managers",
    description: "Runs the day: can create and change, but not delete.",
    permission: {
      ...LANDS,
      docs: ["read", "update"],
      crm: ["read", "create", "update"],
      invoicing: ["read", "create", "update", "send"],
      bookkeeping: ["read"],
      reports: ["read"],
      settings: ["read"],
      scheduling: ["read", "create", "update", "delete"],
      shop: ["read", "create", "update"],
      documents: ["read", "create", "update"],
    },
  },
  {
    name: "staff",
    description: "Does the work: the diary, the customers, the paperwork.",
    permission: {
      ...LANDS,
      docs: ["read"],
      crm: ["read", "create", "update"],
      invoicing: ["read"],
      scheduling: ["read", "create", "update"],
      shop: ["read"],
      documents: ["read", "create", "update"],
    },
  },
  {
    /**
     * Somebody who buys from this business, not somebody who works in it.
     *
     * Deliberately tiny. Seeing only *their own* invoices is not something a
     * role can express — it is row-level, and the portal routes enforce it by
     * resolving the account to a contact and filtering to that contact.
     */
    name: "customers",
    description:
      "A customer of the business: their own invoices, nothing else.",
    permission: { ...LANDS, invoicing: ["read"] },
  },
];

/** What department somebody is in. Attached to a group. */
export const DEFAULT_GROUP_POLICIES: DefaultPolicy[] = [
  {
    name: "sales",
    description: "Wins the work: the book of customers, quotes and invoices.",
    permission: {
      ...LANDS,
      crm: ["read", "create", "update"],
      invoicing: ["read", "create", "update", "send"],
      scheduling: ["read", "create", "update"],
      shop: ["read"],
      documents: ["read", "create"],
    },
  },
  {
    name: "marketing",
    description:
      "Talks to the market: the mailing list, customers and the shop.",
    permission: {
      ...LANDS,
      docs: ["read", "create", "update"],
      crm: ["read", "create", "update"],
      shop: ["read"],
      documents: ["read", "create"],
      // Writing a campaign and putting it in front of eleven thousand people
      // are different decisions; this department does the first.
      newsletter: ["read", "create", "update"],
      /**
       * Links are marketing's, and the domain is not.
       *
       * Writing a link is this department's daily work; pointing a company
       * domain at this instance is an act with DNS behind it and belongs to
       * whoever owns the domain.
       */
      links: ["read", "create", "update", "delete"],
      // Marketing's daily work, including the half that spends money.
      seo: ["read", "create", "update", "delete"],
    },
  },
  {
    /**
     * Whoever does the books.
     *
     * Read on the CRM, because an unpaid invoice is a conversation with a
     * person. Everything on the books, because that is the job.
     */
    name: "accounting",
    description: "Does the books: invoices, payments and the ledger.",
    permission: {
      ...LANDS,
      crm: ["read"],
      invoicing: ["read", "create", "update", "delete", "send"],
      bookkeeping: ["read", "create", "update", "delete"],
      /**
       * Sees what was paid, and pays nobody.
       *
       * The whole job is the books, and a payment out of the bank belongs on
       * them — so `read`. Sending one is a different decision, and a business
       * that wants its bookkeeper making it grants that deliberately.
       */
      payments: ["read"],
      reports: ["read"],
      settings: ["read"],
      scheduling: ["read"],
      shop: ["read"],
      documents: ["read"],
    },
  },
  {
    /**
     * Answers the phone, and can actually fix what is asked about.
     *
     * The diary in full, because moving an appointment is the commonest thing
     * anybody rings about; and orders they can update without being able to
     * change what one cost.
     */
    name: "customer service",
    description: "Answers the phone: the diary, orders, and who people are.",
    permission: {
      ...LANDS,
      crm: ["read", "create", "update"],
      invoicing: ["read"],
      scheduling: ["read", "create", "update", "delete"],
      shop: ["read", "update"],
      documents: ["read"],
    },
  },
];

/**
 * The groups a business starts with, and the policy each carries.
 *
 * Admins and Customers are a group *and* a user policy — a business puts its
 * owners in a group and hands the same access to one person directly, and
 * seeding two roles that mean the same thing would be two places to edit it.
 */
export const DEFAULT_GROUPS: {
  name: string;
  description: string;
  roles: string[];
}[] = [
  {
    name: "Admins",
    description: "Whoever runs this instance.",
    roles: ["admins"],
  },
  { name: "Sales", description: "Wins the work.", roles: ["sales"] },
  {
    name: "Marketing",
    description: "Talks to the market.",
    roles: ["marketing"],
  },
  { name: "Accounting", description: "Does the books.", roles: ["accounting"] },
  {
    name: "Customer Service",
    description: "Answers the phone.",
    roles: ["customer service"],
  },
  {
    name: "Customers",
    description: "People who buy from this business.",
    roles: ["customers"],
  },
];

/** "customer service" is what is stored; "Customer Service" is what is read. */
export function policyLabel(name: string): string {
  return name.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/** Which of the seeded roles is meant for a person, and which for a group. */
export function policyKind(name: string): "user" | "group" | "custom" {
  if (DEFAULT_USER_POLICIES.some((p) => p.name === name)) return "user";
  if (DEFAULT_GROUP_POLICIES.some((p) => p.name === name)) return "group";
  return "custom";
}

/**
 * Puts the defaults in place, once, for an organization that has none.
 *
 * Once and permanently: the marker on the organization records that seeding
 * happened, so a business that threw away five of the six default groups does
 * not find them back tomorrow, and one that rewrote "Managers" does not have
 * the edit reverted. A "create anything missing" seed would do both, every
 * time it ran.
 */
export async function seedDefaults(
  organizationId: string,
  headers: Headers,
): Promise<{ seeded: boolean }> {
  /**
   * Once per organization, whatever else is happening.
   *
   * Two browser tabs opening the screen at the same moment would otherwise
   * both find nothing and both seed, and the second would collide on every
   * name — nine errors on a screen somebody has just opened.
   */
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`users:seed:${organizationId}`}))`,
    );

    const [org] = await tx
      .select({ seededAt: schema.organizations.accessSeededAt })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, organizationId))
      .limit(1);
    if (!org || org.seededAt) return { seeded: false };

    for (const policy of [
      ...DEFAULT_USER_POLICIES,
      ...DEFAULT_GROUP_POLICIES,
    ]) {
      await auth.api
        .createOrgRole({
          body: {
            organizationId,
            role: policy.name,
            permission: policy.permission,
          },
          headers,
        })
        // A name already taken is a business that got there first, which is
        // the outcome this wants anyway.
        .catch(() => undefined);
    }

    for (const group of DEFAULT_GROUPS) {
      const [exists] = await tx
        .select({ id: schema.userGroups.id })
        .from(schema.userGroups)
        .where(
          and(
            eq(schema.userGroups.organizationId, organizationId),
            eq(schema.userGroups.name, group.name),
          ),
        )
        .limit(1);
      if (exists) continue;

      await tx.insert(schema.userGroups).values({
        organizationId,
        name: group.name,
        description: group.description,
        roles: group.roles,
      });
    }

    await tx
      .update(schema.organizations)
      .set({ accessSeededAt: new Date() })
      .where(eq(schema.organizations.id, organizationId));

    return { seeded: true };
  });
}

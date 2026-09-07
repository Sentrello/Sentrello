import { db } from "./client";
import { eq, inArray } from "./orm";
import * as schema from "./schema";

/**
 * Everything one organization owns, removed in one call.
 *
 * Test suites create an organization, fill it, and delete the organization
 * row — and none of these tables has a foreign key to it, so the rows it
 * owned simply stay. A single full run used to leave 72 `organization_role`
 * rows and 24 `user_groups` behind, which is how a test database reaches
 * twenty-five thousand orphaned roles: every suite that calls `seedDefaults`
 * writes nine policies and eight groups, and nothing took them away again.
 *
 * That is slow rather than wrong — but it also makes `select count(*) from
 * organizations = 0`, which this project uses as its "the suite cleaned up
 * after itself" check, a weaker claim than it looks: an empty organizations
 * table says nothing about the seven other tables keyed by an id no longer in
 * it.
 *
 * Deliberately not solved with `on delete cascade`. That would be the right
 * shape in a fresh schema and the wrong thing to add here: the constraint
 * cannot be created while a real deployment still holds orphans, and an audit
 * log that disappears with the organization it describes is a decision to take
 * deliberately rather than one to acquire through a test-hygiene fix.
 *
 * Order matters only for readability — none of these reference each other —
 * but membership goes before the organization so a half-failed call leaves
 * less behind than it found.
 */
export async function dropOrganization(...orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;

  for (const table of [
    schema.securityEvents,
    schema.securityPolicy,
    schema.organizationRole,
    schema.userGroupMembers,
    schema.userGroups,
    schema.invitation,
    schema.member,
  ]) {
    await db.delete(table).where(inArray(table.organizationId, orgIds));
  }

  await db
    .delete(schema.organizations)
    .where(inArray(schema.organizations.id, orgIds));
}

/** The people a suite signed up, and everything hanging off them. */
export async function dropUsers(...emails: string[]): Promise<void> {
  for (const email of emails) {
    const [user] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email.trim().toLowerCase()))
      .limit(1);
    if (!user) continue;
    await db.delete(schema.session).where(eq(schema.session.userId, user.id));
    await db.delete(schema.account).where(eq(schema.account.userId, user.id));
    await db
      .delete(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, user.id));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
  }
}

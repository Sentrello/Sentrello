import { roles } from "@sentrello/auth";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, eq, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";

/**
 * Who can own a record in this CRM.
 *
 * The reference keeps its own `sales` table, with an `administrator` flag and a
 * password of its own. We do not: the platform already knows who works here
 * and what they may do, and a module that invents a second list of people is
 * a second place to forget to remove somebody who has left.
 *
 * So a "CRM manager" is not a row anywhere — it is anybody whose roles let
 * them change a CRM record. Give somebody the Sales role in Users and they
 * appear here; take it away and they stop appearing, with no second screen to
 * remember to visit.
 *
 * `read` alone is not enough. Half a business can see the CRM; the people who
 * can be *given* an account are the ones who can act on it, and offering the
 * whole company in an owner dropdown makes the dropdown useless.
 */

/** What a role must allow before its holder can own CRM records. */
const OWNING_ACTIONS = ["create", "update"] as const;

export interface Manager {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  /** The roles they hold, so a screen can say why they are on the list. */
  roles: string[];
}

/**
 * Whether a set of permissions is enough to own a CRM record.
 *
 * Exported because the rule is worth testing on its own: it is the whole
 * definition of "manager", and it is one line that is easy to get backwards.
 */
export function canOwnCrmRecords(
  permissions: Record<string, string[] | undefined>,
): boolean {
  const crm = permissions.crm ?? [];
  return OWNING_ACTIONS.some((action) => crm.includes(action));
}

export function registerCrmManagers(ctx: ModuleContext) {
  ctx.app.get(
    "/api/crm/managers",
    requireSession(),
    // Everybody who can see the CRM can see who runs it: the list appears in
    // a filter and an owner dropdown, both of which are read-only surfaces.
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));

      const members = await db
        .select({
          userId: schema.member.userId,
          role: schema.member.role,
          name: schema.user.name,
          email: schema.user.email,
          image: schema.user.image,
        })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, orgId));

      /**
       * Roles a business defined for itself, with the permissions it gave
       * them. Read once for the whole list rather than per member — a firm
       * with forty staff on four roles should not be four queries a head.
       */
      const customRoles = await db
        .select({
          role: schema.organizationRole.role,
          permission: schema.organizationRole.permission,
        })
        .from(schema.organizationRole)
        .where(eq(schema.organizationRole.organizationId, orgId));

      // Stored as a JSON string, the way Better Auth's organization plugin
      // writes it. A role whose permissions will not parse is treated as
      // granting nothing rather than as granting everything.
      const customPermissions = new Map(
        customRoles.map((row) => {
          try {
            return [
              row.role,
              JSON.parse(row.permission) as Record<string, string[]>,
            ] as const;
          } catch {
            return [row.role, {} as Record<string, string[]>] as const;
          }
        }),
      );

      const managers: Manager[] = [];
      for (const member of members) {
        // `member.role` is the computed set — the base role plus everything
        // their groups carry — written by the Users module.
        const roles = member.role
          .split(",")
          .map((role) => role.trim())
          .filter(Boolean);

        const owns = roles.some((role) => {
          const custom = customPermissions.get(role);
          if (custom) return canOwnCrmRecords(custom);
          return canOwnCrmRecords(builtIn(role));
        });

        if (owns) {
          managers.push({
            userId: member.userId,
            name: member.name,
            email: member.email,
            image: member.image,
            roles,
          });
        }
      }

      // By the name somebody would look for, not by when they joined.
      managers.sort((a, b) =>
        (a.name ?? a.email).localeCompare(b.name ?? b.email),
      );

      return c.json({ managers });
    },
  );
}

/**
 * What a built-in role allows, read from the access control statement rather
 * than written down a second time.
 *
 * A second copy of this list is a screen that tells an administrator
 * something the permission checks disagree with — and they would believe the
 * screen.
 */
function builtIn(role: string): Record<string, string[]> {
  const known = roles as unknown as Record<
    string,
    { statements?: Record<string, readonly string[]> } | undefined
  >;
  const statements = known[role]?.statements;
  if (!statements) return {};
  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(statements)) {
    if (Array.isArray(actions)) out[resource] = [...actions];
  }
  return out;
}

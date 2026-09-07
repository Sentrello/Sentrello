import { roles as builtInRoles, statement } from "@sentrello/auth";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, inArray, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * What somebody may do, and where it comes from.
 *
 * Learned from the reference, which separates three things this platform used to
 * run together: a **role** is a named set of permissions; a **group** is a set
 * of people; and what a person actually holds is their own role plus the roles
 * of every group they are in.
 *
 * That last part is computed, never typed. `member.role` is comma separated,
 * which Better Auth splits and allows a permission if any of the roles grants
 * it — so groups arrive without a single existing permission check having to
 * know they exist.
 */

/**
 * The roles built into the platform, in the order a screen should list them.
 *
 * Two, because Better Auth reserves exactly these names and a reserved name is
 * one the business can never use for its own. `admin` exists before any
 * organization does, and `customer` is assigned by the portal rather than
 * chosen from a list. Staff and Accounting were here and are ordinary,
 * editable roles now.
 */
export const BUILT_IN = ["admin", "customer"] as const;

/** Every resource the platform guards, and what can be done to each. */
export function permissionMap(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(statement)) {
    out[resource] = [...(actions as readonly string[])];
  }
  return out;
}

/**
 * What a built-in role can do, read from the role itself.
 *
 * Read rather than written down again: a second copy of this list is a screen
 * that tells an administrator something the permission checks disagree with,
 * and they would believe the screen.
 */
export function builtInPermissions(role: string): Record<string, string[]> {
  const known = builtInRoles as unknown as Record<
    string,
    { statements?: Record<string, readonly string[]> } | undefined
  >;
  const found = known[role];
  if (!found?.statements) return {};

  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(found.statements)) {
    if (Array.isArray(actions) && actions.length > 0) {
      out[resource] = [...actions];
    }
  }
  return out;
}

/**
 * What one role actually allows, given this organization's own rows.
 *
 * Lives here rather than in either caller because there are two — `access.ts`
 * resolving a person's grants, and `GET /api/users/roles` describing the
 * policies themselves — and they were answering it differently. That route
 * had `custom[role] ?? builtInPermissions(role)`, which reads as "a business's
 * own definition replaces the built-in one" and is not what authorises:
 * Better Auth starts from the compiled role's statements and unions each
 * resource of the stored row into them, so a stored row narrowing `admin` to
 * `crm:read` still leaves `settings:update` allowed. The compiled statements
 * are a floor, not a default a same-named row can lower. Ruling 30 fixed that
 * in `access.ts` and left this route saying the old thing, so the console's
 * group Access tab — which reads this route — inherited it.
 *
 * For a name Better Auth does not compile there is no floor to stand on: the
 * stored row is the only definition.
 */
export function permissionsForRole(
  role: string,
  custom: Record<string, Record<string, string[]>>,
): Record<string, string[]> {
  if (!(BUILT_IN as readonly string[]).includes(role)) {
    return custom[role] ?? {};
  }
  const builtIn = builtInPermissions(role);
  const extra = custom[role];
  if (!extra) return builtIn;

  const merged: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(builtIn)) {
    merged[resource] = [...actions];
  }
  for (const [resource, actions] of Object.entries(extra)) {
    merged[resource] = [...new Set([...(merged[resource] ?? []), ...actions])];
  }
  return merged;
}

/** Groups this person is in, with the roles each carries. */
export async function groupsOf(
  orgId: string,
  userId: string,
): Promise<(typeof schema.userGroups.$inferSelect)[]> {
  return db
    .select({
      id: schema.userGroups.id,
      organizationId: schema.userGroups.organizationId,
      name: schema.userGroups.name,
      description: schema.userGroups.description,
      roles: schema.userGroups.roles,
      createdAt: schema.userGroups.createdAt,
    })
    .from(schema.userGroupMembers)
    .innerJoin(
      schema.userGroups,
      eq(schema.userGroups.id, schema.userGroupMembers.groupId),
    )
    .where(
      and(
        eq(schema.userGroupMembers.organizationId, orgId),
        eq(schema.userGroupMembers.userId, userId),
      ),
    );
}

export interface EffectiveRoles {
  /** The role this person was given directly. */
  base: string | null;
  /** Roles that arrive through a group, and which group each came from. */
  fromGroups: { role: string; group: string }[];
  /**
   * Roles `member.role` names that neither `base` nor a current group
   * accounts for.
   *
   * `member.role` is what Better Auth actually splits and checks — not this
   * computation. Something can land there without going through `applyRoles`
   * at all: `/api/auth/organization/update-member-role` is exposed through
   * `mountAuth` and writes `member.role` directly, touching neither
   * `baseRole` nor a group. Whatever shows up here is still held, even though
   * nothing in this module can say where it came from.
   */
  unattributed: string[];
  /** Everything, deduplicated — what `member.role` is set to. */
  all: string[];
}

/** Works out what somebody holds, without writing anything. */
export async function effectiveRoles(
  orgId: string,
  userId: string,
): Promise<EffectiveRoles> {
  const [member] = await db
    .select({ role: schema.member.role, baseRole: schema.member.baseRole })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        eq(schema.member.userId, userId),
      ),
    )
    .limit(1);
  if (!member) return { base: null, fromGroups: [], unattributed: [], all: [] };

  const roleTokens = member.role
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  // An instance that has never had groups has no base role written down, and
  // its members' single role is their own. Read it rather than migrating: the
  // first change to either writes both.
  const base = member.baseRole ?? roleTokens[0] ?? null;

  const fromGroups: { role: string; group: string }[] = [];
  for (const group of await groupsOf(orgId, userId)) {
    for (const role of group.roles) {
      fromGroups.push({ role, group: group.name });
    }
  }

  // Everything member.role names that base and the groups above do not
  // already explain is still held, not dropped — see `unattributed` above.
  const groupRoleNames = new Set(fromGroups.map((g) => g.role));
  const unattributed = [
    ...new Set(roleTokens.filter((r) => r !== base && !groupRoleNames.has(r))),
  ];

  const all = [
    ...new Set([base, ...fromGroups.map((g) => g.role), ...unattributed]),
  ].filter((role): role is string => Boolean(role));
  return { base, fromGroups, unattributed, all };
}

/**
 * Writes the computed roles back onto the membership.
 *
 * Called after anything that could change them: a role given directly, a
 * person added to or taken out of a group, a group's own roles edited. One
 * function so there is one answer, and it is the same answer every time.
 */
export async function applyRoles(
  orgId: string,
  userId: string,
): Promise<EffectiveRoles> {
  const roles = await effectiveRoles(orgId, userId);
  if (roles.all.length === 0) return roles;

  // Written back is base ∪ groups — what this function can itself derive,
  // and re-derive the same way every time either changes — not
  // `roles.unattributed`. effectiveRoles reports an unattributed role
  // honestly every time it is asked, which is what the console needs; but if
  // this write folded it back into member.role too, the next recompute would
  // read it back out and call it unattributed all over again, and a role a
  // group used to grant would outlive the group's own removal. This function
  // is what makes member.role agree with base and groups; anything member.role
  // holds beyond that stays exactly as untouched as it already is.
  const derived = [
    ...new Set([roles.base, ...roles.fromGroups.map((g) => g.role)]),
  ].filter((role): role is string => Boolean(role));

  await db
    .update(schema.member)
    .set({ baseRole: roles.base, role: derived.join(",") })
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        eq(schema.member.userId, userId),
      ),
    );
  return roles;
}

/** Everybody whose roles a group change affects. */
export async function membersOfGroup(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.userGroupMembers.userId })
    .from(schema.userGroupMembers)
    .where(eq(schema.userGroupMembers.groupId, groupId));
  return rows.map((r) => r.userId);
}

/**
 * This organization's own roles, read from the table Better Auth itself
 * writes to.
 *
 * Not `auth.api.listOrgRoles`: that endpoint re-authorises the caller against
 * `ac: ["read"]` on their *own* role before it will answer, because it is
 * built for an administrator managing dynamic access control, not for code
 * that already knows it is allowed to be here. The compiled `admin` role
 * carries that statement — it spreads `adminAc.statements`
 * (`packages/auth/src/permissions.ts:77`) — but a seeded policy like `admins`
 * does not, so the second administrator any business creates was refused,
 * silently, every time this ran. The route that calls this has already
 * authorised the caller; asking a second time, of a table this module owns
 * outright, buys nothing and fails closed without saying so.
 */
async function organizationRoles(
  orgId: string,
): Promise<{ role: string; permission: string }[]> {
  return db
    .select({
      role: schema.organizationRole.role,
      permission: schema.organizationRole.permission,
    })
    .from(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
}

/**
 * Role names this organization can actually grant.
 *
 * The built-ins plus whatever the business has defined for itself. Checked
 * before a group is allowed to carry a role, because a group naming a role
 * nobody defined grants nothing and looks like it grants something.
 */
export async function knownRoles(orgId: string): Promise<string[]> {
  const rows = await organizationRoles(orgId);
  return [...new Set([...BUILT_IN, ...rows.map((r) => r.role)])];
}

/**
 * What each of the business's own roles actually allows.
 *
 * The screen has to show this or an administrator is choosing between names.
 * Read from the role rather than written down again — a second copy is a
 * screen that disagrees with the permission checks, and they would believe the
 * screen.
 */
export async function customPermissions(
  orgId: string,
): Promise<Record<string, Record<string, string[]>>> {
  const rows = await organizationRoles(orgId);

  const out: Record<string, Record<string, string[]>> = {};
  for (const row of rows) {
    if (!row.role) continue;
    // The column is JSON stored as text. `listOrgRoles` used to hand this
    // back already parsed into an object; reading the table directly, it is
    // always the string — the object branch stays as a defensive fallback,
    // not because either shape is expected to arrive today.
    let permission: Record<string, string[]> = {};
    if (typeof row.permission === "string") {
      try {
        permission = JSON.parse(row.permission || "{}");
      } catch {
        permission = {};
      }
    } else if (row.permission && typeof row.permission === "object") {
      permission = row.permission as Record<string, string[]>;
    }
    out[row.role] = permission;
  }
  return out;
}

/**
 * Whether this person must have a second factor.
 *
 * Asked of the roles they hold rather than of them: the person who can move
 * money is not the person who clocks in on a shared tablet, and a business
 * that has to force both will force neither.
 */
export function twoFactorRequired(
  policy: { requireTwoFactorFor: string[] } | null,
  roles: string[],
): boolean {
  if (!policy || policy.requireTwoFactorFor.length === 0) return false;
  return roles.some((role) => policy.requireTwoFactorFor.includes(role));
}

/**
 * One role's own detail: what it grants, and who holds it.
 *
 * `GET /api/users/roles` already lists every role with what each grants;
 * this is the drill-down a screen needs when an administrator opens one —
 * everybody who holds it, whether given directly (`member.baseRole`) or
 * carried by a group they are in, and which groups those are. Direct and
 * group-held are checked separately rather than through `effectiveRoles`
 * per member: this reads `member.role`/`baseRole` and group membership in
 * two bulk queries for the whole organization, not one query per member.
 */
export function registerRolePolicy(ctx: ModuleContext) {
  /**
   * Three segments (`/api/users/roles/:role`), so it cannot be shadowed by
   * `registerPeople`'s two-segment `GET /api/users/:userId` either way
   * round. It does share its shape with `access.ts`'s three-segment
   * `GET /api/users/:userId/access`, though, and the two patterns collide
   * for the one literal path where both could match: a role named `access`
   * makes `GET /api/users/roles/access` ambiguous with `GET
   * /api/users/:userId/access` read as `userId="roles"`. Whichever of the
   * two routes is registered first answers that one path; no business role
   * is plausibly named `access`, so this is worth the comment it is getting
   * rather than a guard neither route needs for any role that is.
   */
  ctx.app.get(
    "/api/users/roles/:role",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const role = c.req.param("role") ?? "";

      // Same formula `GET /api/users/roles` already shows per role
      // (`groups.ts`) — read from the role itself, not written down again,
      // so this detail screen cannot disagree with the list it drills down
      // from.
      const custom = await customPermissions(orgId);
      // `permissionsForRole`, not `custom[role] ?? builtInPermissions(role)` —
      // see its docstring above. This route is the single-policy half of the
      // pair `GET /api/users/roles` forms, and it kept the old expression when
      // the list route was corrected: the fix landed in this file and the
      // file's own other route was never switched to call it. That is the
      // third time this rule has been found expressed two ways, so the sweep
      // to run is `grep "?? builtInPermissions"`, not a reading of whichever
      // screen looked wrong.
      const permission = permissionsForRole(role, custom);

      const allGroups = await db
        .select({
          id: schema.userGroups.id,
          name: schema.userGroups.name,
          roles: schema.userGroups.roles,
        })
        .from(schema.userGroups)
        .where(eq(schema.userGroups.organizationId, orgId));
      const groupsWithRole = allGroups.filter((g) => g.roles.includes(role));

      const throughGroup = groupsWithRole.length
        ? new Set(
            (
              await db
                .select({ userId: schema.userGroupMembers.userId })
                .from(schema.userGroupMembers)
                .where(
                  and(
                    eq(schema.userGroupMembers.organizationId, orgId),
                    inArray(
                      schema.userGroupMembers.groupId,
                      groupsWithRole.map((g) => g.id),
                    ),
                  ),
                )
            ).map((r) => r.userId),
          )
        : new Set<string>();

      const memberRows = await db
        .select({
          userId: schema.member.userId,
          role: schema.member.role,
          baseRole: schema.member.baseRole,
          name: schema.user.name,
          email: schema.user.email,
        })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, orgId));

      const members = memberRows
        .filter((m) => {
          // Same fallback `effectiveRoles` uses above: an instance that has
          // never had groups has no `baseRole` written down, and its
          // members' first (and only) role token is their own.
          const held = m.role.split(",").filter(Boolean);
          const base = m.baseRole ?? held[0] ?? null;
          return base === role || throughGroup.has(m.userId);
        })
        .map((m) => ({ userId: m.userId, name: m.name, email: m.email }));

      return c.json({
        role,
        permission,
        members,
        groups: groupsWithRole.map((g) => ({ id: g.id, name: g.name })),
      });
    },
  );
}

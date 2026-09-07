import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { groupNames, idFrom } from "./groups";
import {
  type EffectiveRoles,
  customPermissions,
  effectiveRoles,
  permissionsForRole,
} from "./roles";

export interface Grant {
  resource: string;
  action: string;
  /**
   * Every route to it. A grant reachable two ways names both.
   *
   * A group source's `name` is the group's own display name (`"Accounting"`,
   * `"Customer Service"`), entered by whoever created it. A policy source's
   * `name` is the stored, lower-cased role key (`"accounting"`,
   * `"customer service"`) — the same form `roles.base` and
   * `roles.fromGroups[].role` already carry, and the same form
   * `GET /api/users/roles` hands back for the same roles. Left un-labelled
   * on purpose, for the same reason: this module already has one place that
   * turns a stored key into a heading (`policyLabel`, `defaults.ts:255`, and
   * its duplicate in `apps/web/src/routes/users.tsx`), and a second place
   * making that call here would be a second place it could disagree with the
   * first.
   */
  sources: { kind: "policy" | "group"; name: string }[];
}

/**
 * The union itself, over any list of (role, source) pairs.
 *
 * Separated from `resolveAccess` because a group's Access tab asks the same
 * question about the roles a group carries, and was answering it in the
 * browser: `grantsForRoles` in `apps/web/src/routes/users/group.tsx` was a
 * second implementation of this, fed by `GET /api/users/roles`. Two
 * implementations of "what does this add up to" is exactly the shape that
 * produced Rulings 30, 45 and the third instance after them — the same rule
 * written down twice and corrected once.
 *
 * So there is one union, on the server, and both screens ask it.
 */
export async function grantsFor(
  organizationId: string,
  held: { role: string; source: Grant["sources"][number] }[],
): Promise<Grant[]> {
  const custom = await customPermissions(organizationId);
  /**
   * A custom row under a name Better Auth compiles — `admin` or `customer`,
   * reachable only by writing to the organization's own role table directly,
   * since Better Auth's own endpoint refuses to create an org role under a
   * name it has compiled in — adds to that compiled role rather than
   * replacing it. Verified at runtime, not assumed: `hasPermission`
   * (`better-auth/dist/plugins/organization/has-permission.mjs`) starts from
   * the compiled role's own statements and unions each resource in the
   * custom row into them, so narrowing a stored `admin` row to `crm:read`
   * still leaves `settings:update` and `bookkeeping:delete` allowed, and a
   * resource the compiled role does not mention at all — `inventory`, which
   * no built-in role grants — is still allowed if the custom row adds it.
   * The compiled statements are the floor, not a default that a same-named
   * row can lower.
   *
   * For every other name there is no compiled definition to add to: the
   * stored row is the only definition, exactly as before.
   */
  const permissionsOf = (role: string) => permissionsForRole(role, custom);

  // Keyed `resource:action` so a grant is recorded once with every route to
  // it, rather than once per role.
  const found = new Map<string, Grant>();
  const add = (
    role: string,
    source: { kind: "policy" | "group"; name: string },
  ) => {
    // A role held through a group or given directly can name a permission
    // set that grants nothing — one nobody ever defined, or one a business
    // wrote down as `{}` on purpose. That is not the same thing as the role
    // not existing: it still appears in `roles.all` and `roles.fromGroups`
    // above, truthfully, as something this person holds. It simply adds no
    // grants here, which is also the truth.
    for (const [resource, actions] of Object.entries(permissionsOf(role))) {
      for (const action of actions) {
        const key = `${resource}:${action}`;
        const existing = found.get(key);
        if (!existing) {
          found.set(key, { resource, action, sources: [source] });
          continue;
        }
        const already = existing.sources.some(
          (s) => s.kind === source.kind && s.name === source.name,
        );
        if (!already) existing.sources.push(source);
      }
    }
  };

  for (const { role, source } of held) add(role, source);

  const grants = [...found.values()].sort(
    (a, b) =>
      a.resource.localeCompare(b.resource) || a.action.localeCompare(b.action),
  );
  return [...found.values()].sort(
    (a, b) =>
      a.resource.localeCompare(b.resource) || a.action.localeCompare(b.action),
  );
}

/**
 * What somebody may actually do, and how each part of it reached them.
 *
 * Their effective permissions are the union of the policy given to them
 * directly and the policies carried by every group they are in. That union is
 * computed inside the server when a request is authorised and has never been
 * shown to anybody, so the question an administrator most wants answered —
 * what can this person do — was answered by reading two tables and doing the
 * union in their head.
 *
 * Sources are kept per grant, not per role, because that is the question
 * behind the question. Somebody whose own policy and whose group both grant
 * `invoicing:read` keeps it when they leave the group, and an administrator
 * who cannot see that removes the wrong thing.
 */
export async function resolveAccess(
  organizationId: string,
  userId: string,
): Promise<{ grants: Grant[]; roles: EffectiveRoles }> {
  const roles = await effectiveRoles(organizationId, userId);
  if (roles.all.length === 0) return { grants: [], roles };

  const held: { role: string; source: Grant["sources"][number] }[] = [];
  if (roles.base) {
    held.push({
      role: roles.base,
      source: { kind: "policy", name: roles.base },
    });
  }
  // Held by member.role but attributable to no policy and no group — still
  // held, so still resolved, with the role's own name as the only honest
  // source there is for it.
  for (const role of roles.unattributed) {
    held.push({ role, source: { kind: "policy", name: role } });
  }
  for (const g of roles.fromGroups) {
    held.push({ role: g.role, source: { kind: "group", name: g.group } });
  }

  return { grants: await grantsFor(organizationId, held), roles };
}

/** What one person holds, and where each part of it comes from. */
export function registerAccess(ctx: ModuleContext) {
  /**
   * The same question about a group: what do the policies it carries add up
   * to, and which of them carries each part.
   *
   * Answered here rather than in the browser. The group screen worked this
   * out itself from `GET /api/users/roles`, which meant two implementations
   * of the union — and this branch has already corrected the same rule in
   * three places after writing it down twice, which is the argument for not
   * having a fourth in a language the server cannot check.
   *
   * Every source is a `policy`, because that is what a group carries. The
   * group is not its own source: an administrator reading this already knows
   * which group they opened, and naming it on every row would say nothing
   * the heading does not.
   */
  ctx.app.get(
    "/api/users/groups/:id/access",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      // `idFrom` rather than the raw param, reusing what `groups.ts` already
      // does for every other route that takes this id: `user_groups.id` is a
      // `uuid` column, so Postgres refuses to compare it with a string that is
      // not one and the request dies in the driver — a 500 for what is the
      // plainest possible 404, an id no row could ever have.
      const id = idFrom(c);
      if (!id) return c.json({ error: "not found" }, 404);

      const [group] = await db
        .select({ roles: schema.userGroups.roles })
        .from(schema.userGroups)
        .where(
          and(
            eq(schema.userGroups.id, id),
            eq(schema.userGroups.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!group) return c.json({ error: "not found" }, 404);

      const grants = await grantsFor(
        orgId,
        group.roles.map((role) => ({
          role,
          source: { kind: "policy" as const, name: role },
        })),
      );
      return c.json({ grants });
    },
  );

  ctx.app.get(
    "/api/users/:userId/access",
    requireSession(),
    // `settings:read` answered this until now, which is the same hole
    // Ruling 20 closed on `GET /api/users/:userId` the task before this one:
    // this route answers "what may this person do" for anybody, including
    // the administrators, which makes it the single most useful thing in the
    // module to somebody deciding whose account to go after. `update` is not
    // uniform across the module — five reads still gate on `settings:read`
    // (`GET /api/users/roles`, `/api/users/groups`, `/api/users/policy`,
    // `/api/users/:userId/sessions`, `/api/users/sso`) — but this one holds
    // out because of what it answers, not because of what shape the route is.
    // A read-only viewer role is a permissions decision to make deliberately
    // later, not one to inherit from here.
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const userId = c.req.param("userId") ?? "";
      const { grants, roles } = await resolveAccess(orgId, userId);
      if (roles.all.length === 0 && !roles.base) {
        return c.json({ error: "not found" }, 404);
      }
      return c.json({ grants, roles, groups: await groupNames(orgId, userId) });
    },
  );
}

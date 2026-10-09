import { createHash, randomBytes } from "node:crypto";
import { and, db, eq, isNull, lt, or, schema, sql } from "@sentrello/db";
import { daysLate } from "@sentrello/db/day";
import { timezoneFor } from "@sentrello/db/timezone";
import { hasPermission } from "better-auth/plugins";
import { auth } from "./index";
import { statement } from "./permissions";

/**
 * Keys for callers that are not people.
 *
 * Resolved in `requireSession`, beside the session cookie, so every route that
 * already asks "who is this" and "may they" works for a key without knowing
 * keys exist. The rules that make that safe live here:
 *
 * - A key acts for whoever made it and **never beyond them**. It carries its
 *   own permissions, checked first, and the maker's current access is asked
 *   as well on every call — so somebody demoted, removed or suspended takes
 *   their keys' reach down with them, rather than leaving a script holding
 *   what they used to have.
 * - The key is never stored. Its SHA-256 is, and a lookup is an indexed probe
 *   on that hash: there is no list of candidates to compare one by one, so
 *   the cost of a guess does not grow with the number of keys.
 */

const PREFIX = "sntl_";

/** The stored form of a key. Fast on purpose: the key is 256 random bits. */
export const hashApiKey = (key: string) =>
  createHash("sha256").update(key).digest("hex");

/** A new key, its visible prefix, and the hash that is all we keep. */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    key,
    prefix: key.slice(0, PREFIX.length + 6),
    hash: hashApiKey(key),
  };
}

/**
 * `Bearer sntl_…`, or nothing.
 *
 * Only a token in our own shape is ours to read. A proxy in front of an
 * instance can put a bearer token of its own on every request — an identity
 * proxy passing its sign-in through is the usual one — and treating that as a
 * wrong key would refuse every signed-in person behind it. A token that is
 * not ours leaves the request to the cookie, exactly as before keys existed.
 */
export function bearerKey(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const token = match?.[1];
  return token?.startsWith(PREFIX) ? token : null;
}

export interface ApiKeyCaller {
  id: string;
  name: string;
  organizationId: string;
  permissions: Record<string, string[]>;
  user: { id: string; name: string | null; email: string | null };
}

/**
 * The key a request presents, if it is one that still works.
 *
 * Null for every way it can fail — unknown, revoked, past its day, or made
 * by somebody who is no longer a member or is suspended — because the caller
 * should learn nothing from the difference. A script with a dead key needs to
 * be told "no", and an attacker needs to be told nothing more.
 */
export async function resolveApiKey(
  presented: string,
  now = new Date(),
): Promise<ApiKeyCaller | null> {
  // Not in our shape, or longer than any key could be: no lookup.
  if (!presented.startsWith(PREFIX) || presented.length > 100) return null;

  const [row] = await db
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      organizationId: schema.apiKeys.organizationId,
      permissions: schema.apiKeys.permissions,
      createdBy: schema.apiKeys.createdBy,
      expiresOn: schema.apiKeys.expiresOn,
      revokedAt: schema.apiKeys.revokedAt,
      userName: schema.user.name,
      userEmail: schema.user.email,
    })
    .from(schema.apiKeys)
    .innerJoin(schema.user, eq(schema.user.id, schema.apiKeys.createdBy))
    .where(eq(schema.apiKeys.tokenHash, hashApiKey(presented)))
    .limit(1);
  if (!row || row.revokedAt) return null;

  if (row.expiresOn) {
    const zone = await timezoneFor(row.organizationId);
    if (daysLate(row.expiresOn, now, zone) > 0) return null;
  }

  // Removed or suspended, the maker's keys stop with them: suspending
  // somebody ends their sessions, and a key is one more way in.
  const [member] = await db
    .select({ disabledAt: schema.member.disabledAt })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, row.organizationId),
        eq(schema.member.userId, row.createdBy),
      ),
    )
    .limit(1);
  if (!member || member.disabledAt) return null;

  /*
   * When it was last used, at most once a minute.
   *
   * The same trade the session makes with `updateAge`: a meter posting every
   * few seconds should not be a write every few seconds, and "last used a
   * minute ago" answers the question the column is for — is anything still
   * using this key before I revoke it.
   */
  await db
    .update(schema.apiKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(schema.apiKeys.id, row.id),
        eq(schema.apiKeys.organizationId, row.organizationId),
        or(
          isNull(schema.apiKeys.lastUsedAt),
          lt(schema.apiKeys.lastUsedAt, sql`now() - interval '1 minute'`),
        ),
      ),
    );

  return {
    id: row.id,
    name: row.name,
    organizationId: row.organizationId,
    permissions: row.permissions,
    user: { id: row.createdBy, name: row.userName, email: row.userEmail },
  };
}

/** Whether a key's own list covers everything a route asks for. */
export function keyCovers(
  granted: Record<string, string[]>,
  wanted: Record<string, string[]>,
): boolean {
  return Object.entries(wanted).every(([resource, actions]) =>
    actions.every((action) => (granted[resource] ?? []).includes(action)),
  );
}

/**
 * Whether a member may do something, asked of Better Auth's own check.
 *
 * Not reimplemented: `hasPermission` is the function the library's endpoint
 * calls with the session's member, so this is the same answer a signed-in
 * request would get — compiled roles, the business's own roles merged over
 * them, and a comma-separated `member.role` read the same way. It is called
 * directly because there is no session here to call the endpoint with.
 */
export async function memberMay(
  organizationId: string,
  userId: string,
  permissions: Record<string, string[]>,
): Promise<boolean> {
  const [member] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, organizationId),
        eq(schema.member.userId, userId),
      ),
    )
    .limit(1);
  if (!member) return false;

  const plugin = auth.options.plugins.find((p) => p.id === "organization") as
    | { options: Parameters<typeof hasPermission>[0]["options"] }
    | undefined;
  if (!plugin) return false;

  try {
    return await hasPermission(
      {
        role: member.role,
        options: plugin.options,
        permissions,
        organizationId,
      },
      { context: await auth.$context } as unknown as Parameters<
        typeof hasPermission
      >[1],
    );
  } catch {
    return false;
  }
}

/** What a key caller may do: its own list, and its maker's current access. */
export async function apiKeyMay(
  key: Pick<ApiKeyCaller, "organizationId" | "permissions"> & {
    user: { id: string };
  },
  permissions: Record<string, string[]>,
): Promise<boolean> {
  if (!keyCovers(key.permissions, permissions)) return false;
  return memberMay(key.organizationId, key.user.id, permissions);
}

/**
 * The permissions a new key may carry, or why not.
 *
 * Each pair is checked on its own against the maker, rather than the whole
 * set at once: somebody holding invoicing through their own policy and the
 * CRM through a group holds both, and Better Auth answers a combined question
 * one role at a time.
 */
export async function grantableBy(
  organizationId: string,
  userId: string,
  requested: unknown,
): Promise<
  | { ok: true; permissions: Record<string, string[]> }
  | { ok: false; error: string }
> {
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
    return { ok: false, error: "permissions must name at least one action" };
  }
  const known = statement as unknown as Record<string, readonly string[]>;
  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(requested)) {
    if (!Array.isArray(actions)) {
      return { ok: false, error: `${resource} must be a list of actions` };
    }
    for (const action of actions) {
      if (typeof action !== "string" || !known[resource]?.includes(action)) {
        return {
          ok: false,
          error: `there is no permission ${resource}: ${action}`,
        };
      }
      if (
        !(await memberMay(organizationId, userId, { [resource]: [action] }))
      ) {
        return {
          ok: false,
          error: `you do not hold ${resource}: ${action}, so a key you make cannot either`,
        };
      }
      out[resource] = [...new Set([...(out[resource] ?? []), action])];
    }
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, error: "permissions must name at least one action" };
  }
  return { ok: true, permissions: out };
}

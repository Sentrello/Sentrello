import { afterAll, expect, test } from "bun:test";
import { and, db, eq, schema } from "@sentrello/db";
import { dropOrganization, dropUsers } from "@sentrello/db/testing";
import { Hono } from "hono";
import { mountAuth } from "./hono";
import { auth } from "./index";
import { signUpAsOwner } from "./testing";

/**
 * The library's own membership changes are not reachable over HTTP.
 *
 * Removing somebody, re-roling them, or leaving goes through the Users screen,
 * which takes group rows, API keys and sessions with the membership and will
 * not leave a business without an administrator. The library answers the same
 * changes at `/api/auth/organization/*` and does none of that. Each is refused
 * with the answer the SSO administration endpoints give, and the role-policy
 * endpoints the policies screen calls still answer.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `membership-door-${suffix}@example.test`;
const otherEmail = `membership-other-${suffix}@example.test`;
const base = process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000";

const app = new Hono();
mountAuth(app as never);

let orgId = "";

afterAll(async () => {
  if (orgId) await dropOrganization(orgId);
  await dropUsers(ownerEmail, otherEmail);
});

test("each membership-changing endpoint answers not found, and changes nothing", async () => {
  const signUp = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = { cookie, origin: base, "content-type": "application/json" };

  const org = await auth.api.createOrganization({
    body: { name: `Door ${suffix}`, slug: `door-${suffix}` },
    headers: new Headers(headers),
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: new Headers(headers),
  });

  const other = await signUpAsOwner({
    email: otherEmail,
    password: "correct-horse-battery-staple",
    name: "Staff",
  });
  const otherId = other.response.user.id;
  const memberId = crypto.randomUUID();
  await db.insert(schema.member).values({
    id: memberId,
    organizationId: orgId,
    userId: otherId,
    role: "staff",
    baseRole: "staff",
    createdAt: new Date(),
  });

  const bodies: Record<string, unknown> = {
    "remove-member": { memberIdOrEmail: memberId, organizationId: orgId },
    leave: { organizationId: orgId },
    "update-member-role": { memberId, role: "admin", organizationId: orgId },
    "invite-member": { email: `x-${suffix}@example.test`, role: "admin" },
    "accept-invitation": { invitationId: crypto.randomUUID() },
    "reject-invitation": { invitationId: crypto.randomUUID() },
    "cancel-invitation": { invitationId: crypto.randomUUID() },
  };
  for (const [path, body] of Object.entries(bodies)) {
    for (const spelled of [path, `${path}/`]) {
      const res = await app.request(
        `${base}/api/auth/organization/${spelled}`,
        { method: "POST", headers, body: JSON.stringify(body) },
      );
      expect(`${spelled} ${res.status}`).toBe(`${spelled} 404`);
      expect(await res.json()).toEqual({ error: "not found" });
    }
  }

  // Nothing moved: both memberships stand, at the roles they had.
  const seats = await db
    .select({ userId: schema.member.userId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.organizationId, orgId));
  expect(seats.find((s) => s.userId === otherId)?.role).toBe("staff");
  expect(seats).toHaveLength(2);
  const invited = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.organizationId, orgId),
        eq(schema.invitation.email, `x-${suffix}@example.test`),
      ),
    );
  expect(invited).toHaveLength(0);

  // The policies screen's own calls still reach the library.
  const roles = await app.request(
    `${base}/api/auth/organization/list-roles?organizationId=${orgId}`,
    { headers },
  );
  expect(roles.status).not.toBe(404);
});

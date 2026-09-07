import { clientIp, clientIpOptions } from "@sentrello/auth";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, eq, schema } from "@sentrello/db";
import { mailConfigured } from "@sentrello/email";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * What the Authentication screen cannot otherwise see about this instance
 * (`docs/plan/Users-IAM-Console-Design.md` §8).
 *
 * Three facts, none readable from the browser today: which header this
 * instance trusts for a caller's address and what this request resolved to
 * — the way this is otherwise discovered is that lockout locks everybody at
 * once, because every request appears to come from the proxy; whether the
 * configured base URL is `https`, because a `Secure` cookie is not sent over
 * plain HTTP and sign-in then appears to succeed and does nothing; and how
 * many administrators can still sign in, so a business choosing to have one
 * can be told what that means while mail is unconfigured, not after they are
 * locked out.
 *
 * `settings:update`, the same gate as every other administrative route in
 * this module. Not `/api/_signin` — that stays unauthenticated for the
 * sign-in page, and the header this instance trusts is not something to hand
 * an anonymous caller.
 */
export function registerDiagnostics(ctx: ModuleContext) {
  ctx.app.get(
    "/api/users/diagnostics",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));

      const members = await db
        .select({
          role: schema.member.role,
          disabledAt: schema.member.disabledAt,
        })
        .from(schema.member)
        .where(eq(schema.member.organizationId, orgId));
      // The same rule `people.ts`'s `isLastAdministrator` uses: comma-split
      // for a role held through a group, and only a member still able to
      // sign in — `disabledAt` null — counts.
      const administrators = members.filter(
        (m) => m.role.split(",").includes("admin") && !m.disabledAt,
      ).length;

      const baseUrl = process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000";
      const ipHeader =
        clientIpOptions(process.env).ipAddressHeaders[0] ?? "x-real-ip";

      return c.json({
        ipHeader,
        resolvedIp: clientIp(c),
        baseUrl,
        https: baseUrl.startsWith("https://"),
        mailConfigured: mailConfigured(),
        administrators,
      });
    },
  );
}

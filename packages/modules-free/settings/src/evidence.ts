import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, desc, eq, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { personalDataSources } from "@sentrello/module-sdk";

/**
 * The things an auditor asks for, in one file.
 *
 * A business using this platform may be going through a SOC 2 audit, or ISO
 * 27001, or answering a large customer's security questionnaire. The platform
 * cannot be SOC 2 certified on their behalf — the audit examines *their*
 * organisation, its controls and how it operates them — but almost every
 * evidence request lands on the software, and the difference between a
 * comfortable audit and a miserable one is whether the answers can be produced
 * or have to be assembled by hand from screenshots.
 *
 * These are the four that come up every time, in the auditor's own terms:
 *
 * - **Logical access, CC6.1–6.3.** Who has access, at what level, and is it
 *   still appropriate. The quarterly access review is the single most common
 *   SOC 2 finding, and it fails because nobody can produce the list.
 * - **Termination, CC6.2.** Access removed promptly when somebody leaves, with
 *   a date. The removal is in the security log; this puts it beside the list.
 * - **Authentication, CC6.1.** Who has a second factor and who does not.
 * - **Data inventory, CC3.2 and P-series.** What personal data is held and for
 *   how long — the same registry the privacy screen reads, because a second
 *   inventory would be a second thing to keep in step.
 *
 * It is deliberately a plain export rather than a dashboard with a score. A
 * compliance score invites somebody to improve the score, and what an auditor
 * wants is the underlying facts with a date on them.
 */
export function registerEvidence(ctx: ModuleContext) {
  ctx.app.get(
    "/api/compliance/evidence",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));

      /**
       * Everybody with access, what they can do, and whether they have a second
       * factor.
       *
       * Joined here rather than left as three lists, because the question an
       * auditor asks is about one person at a time: "this person left in March,
       * why did they sign in in April".
       */
      const members = await db
        .select({
          userId: schema.member.userId,
          role: schema.member.role,
          memberSince: schema.member.createdAt,
          name: schema.user.name,
          email: schema.user.email,
          twoFactorEnabled: schema.user.twoFactorEnabled,
          emailVerified: schema.user.emailVerified,
        })
        .from(schema.member)
        .leftJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, orgId));

      /**
       * Every change to who could do what, which is the trail the access
       * review is checked against.
       */
      const log = await db
        .select()
        .from(schema.securityEvents)
        .where(eq(schema.securityEvents.organizationId, orgId))
        .orderBy(desc(schema.securityEvents.at))
        .limit(1000);

      const [compliance] = await db
        .select()
        .from(schema.complianceSettings)
        .where(eq(schema.complianceSettings.organizationId, orgId))
        .limit(1);

      return c.json({
        generatedAt: new Date().toISOString(),
        /*
         * Said at the top of the file the auditor opens, because the sentence
         * a vendor most wants to blur is this one, and blurring it is how a
         * business ends up believing an audit is finished when it has not
         * started.
         */
        note: "Evidence produced by the software. It does not constitute an audit, and this platform is not itself certified. What follows are the facts an auditor asks for; the controls and how they are operated are the business's own.",

        access: {
          control: "CC6.1–6.3 — logical access",
          people: members.map((m) => ({
            name: m.name,
            email: m.email,
            role: m.role,
            memberSince: m.memberSince,
            twoFactorEnabled: Boolean(m.twoFactorEnabled),
            emailVerified: Boolean(m.emailVerified),
          })),
          withoutSecondFactor: members.filter((m) => !m.twoFactorEnabled)
            .length,
        },

        accessChanges: {
          control: "CC6.2 — granting and removing access",
          events: log
            .filter((e) =>
              [
                "role.changed",
                "member.removed",
                "member.invited",
                "invitation.cancelled",
                "group.joined",
                "group.left",
                "account.disabled",
                "account.enabled",
                "sessions.revoked",
                "two-factor.revoked",
              ].includes(e.action),
            )
            .map((e) => ({
              at: e.at,
              action: e.action,
              by: e.actorName,
              to: e.subjectName,
            })),
        },

        dataHeld: {
          control: "CC3.2 — what is held, and for how long",
          sources: personalDataSources().map((s) => ({
            module: s.moduleId,
            label: s.label,
            retention: s.retention,
            canEraseOnRequest: Boolean(s.erase),
          })),
        },

        safeguards: {
          control: "CC6.1, CC6.6 — configured protections",
          hipaaSafeguards: compliance?.hipaa ?? false,
          idleTimeoutMinutes: compliance?.idleTimeoutMinutes ?? null,
          readsOfHealthDataLogged: compliance?.logReads ?? false,
          secondFactorRequired: compliance?.requireTwoFactor ?? false,
          riskAssessmentOn: compliance?.riskAssessmentOn ?? null,
        },

        /**
         * What this cannot evidence, named rather than omitted.
         *
         * An evidence pack that lists only what it can produce reads as a
         * complete answer. These four are the ones an auditor will ask for next
         * and the software has no view of — and a business finding that out
         * from their auditor rather than from us is the avoidable version.
         */
        notEvidencedHere: [
          "Change management — how code reaching this server is reviewed and approved",
          "Backups and restore testing — the schedule is on the server, not in the application",
          "Physical and environmental controls — wherever this server lives",
          "Vendor management — the agreements with whoever hosts it and sends its email",
        ],
      });
    },
  );
}

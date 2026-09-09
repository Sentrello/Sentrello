import {
  activeOrganizationId,
  forgetHipaaRules,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import { record as recordSecurityEvent } from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * HIPAA safeguards, for the businesses that need them.
 *
 * **The name is the honest part.** This is "HIPAA safeguards", never "HIPAA
 * compliant". Compliance is a programme a business runs — a risk assessment,
 * workforce training, business associate agreements, a breach response plan —
 * and no switch in any product grants it. A vendor who says otherwise is
 * selling something that does not exist, and the practice that believes them
 * finds out during an investigation.
 *
 * What software can do is provide the technical safeguards §164.312 asks for
 * and refuse to be the weak part:
 *
 * - **Audit controls, §164.312(b).** Record every *read* of a record that may
 *   hold health information, not only every change. This is the one most
 *   systems lack and the one an investigation actually needs: "who looked at
 *   this patient's record" cannot be answered by a log of writes.
 * - **Automatic logoff, §164.312(a)(2)(iii).** An idle timeout, on a screen a
 *   receptionist leaves unlocked in a room patients walk through.
 * - **Person authentication, §164.312(d).** Two factors for everybody.
 *
 * Off by default, and deliberately: most businesses running this are not
 * covered entities, and imposing a fifteen-minute timeout and mandatory
 * two-factor on a florist would be a cost for nothing.
 */
export function registerCompliance(ctx: ModuleContext) {
  const settingsFor = async (orgId: string) => {
    const [row] = await db
      .select()
      .from(schema.complianceSettings)
      .where(eq(schema.complianceSettings.organizationId, orgId))
      .limit(1);
    if (row) return row;
    const [made] = await db
      .insert(schema.complianceSettings)
      .values({ organizationId: orgId })
      .returning();
    return made;
  };

  ctx.app.get(
    "/api/compliance",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const settings = await settingsFor(orgId);

      /**
       * What the business still has to do itself, listed rather than implied.
       *
       * Every item here is something the Security Rule requires and no software
       * can perform. A screen that switches on three technical controls and
       * says nothing about the rest leaves a practice believing it is finished,
       * which is the failure mode this whole feature could most easily cause.
       */
      return c.json({
        settings,
        yourOwnObligations: [
          {
            what: "A written risk assessment",
            rule: "§164.308(a)(1)(ii)(A)",
            why: "The commonest finding in a small practice is that nobody can produce one, or a date.",
            done: Boolean(settings?.riskAssessmentOn),
          },
          {
            what: "A Business Associate Agreement with anybody who can see the data",
            rule: "§164.308(b)(1)",
            why: "Your hosting provider, your backup storage, your email relay. Sentrello is self-hosted, so if you run it yourself we never see your data and no agreement with us is needed — but the server it sits on is somebody's.",
            done: null,
          },
          {
            what: "Workforce training, and a record of who had it",
            rule: "§164.308(a)(5)",
            why: "The control that fails is a person, not a server.",
            done: null,
          },
          {
            what: "A breach notification plan",
            rule: "§164.400–414",
            why: "Sixty days, and the clock starts when somebody discovers it rather than when you finish investigating.",
            done: null,
          },
          {
            what: "Encryption at rest on this server, and on your backups",
            rule: "§164.312(a)(2)(iv)",
            why: "This application cannot see the disk it runs on. Full-disk encryption is set up where the server is, not here.",
            done: null,
          },
        ],
      });
    },
  );

  ctx.app.put(
    "/api/compliance",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const before = await settingsFor(orgId);

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.hipaa !== undefined) patch.hipaa = body.hipaa === true;
      if (body.logReads !== undefined) patch.logReads = body.logReads === true;
      if (body.requireTwoFactor !== undefined) {
        patch.requireTwoFactor = body.requireTwoFactor === true;
      }
      if (body.idleTimeoutMinutes !== undefined) {
        const minutes = Number(body.idleTimeoutMinutes);
        /*
         * A ceiling, not a suggestion. "Automatic logoff after eight hours" is
         * a setting that satisfies the letter of a checklist and protects
         * nobody, and the whole reason this switch exists is the screen left
         * open in a room patients walk through.
         */
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
          return c.json(
            { error: "an idle timeout is between 1 and 60 minutes" },
            400,
          );
        }
        patch.idleTimeoutMinutes = minutes;
      }
      if (body.riskAssessmentOn !== undefined) {
        patch.riskAssessmentOn = body.riskAssessmentOn
          ? new Date(String(body.riskAssessmentOn))
          : null;
      }

      const [row] = await db
        .update(schema.complianceSettings)
        .set(patch)
        .where(eq(schema.complianceSettings.organizationId, orgId))
        .returning();

      // The guard caches these for a few seconds to stay off the hot path.
      // Switching them on from this screen should take effect immediately, not
      // after the next person waits out a cache.
      forgetHipaaRules(orgId);

      /**
       * Turning the safeguards off is itself an event worth recording.
       *
       * Somebody switching HIPAA mode off is either a business that stopped
       * being a covered entity or somebody trying to make an audit trail stop.
       * Both are worth a line in the log, and the second is the reason.
       */
      if (before?.hipaa !== row?.hipaa) {
        const session = c.get("session");
        await recordSecurityEvent({
          organizationId: orgId,
          actor: { id: session?.user?.id ?? "", name: session?.user?.name },
          action: row?.hipaa ? "hipaa.enabled" : "hipaa.disabled",
        });
      }

      return c.json({ settings: row });
    },
  );
}

/**
 * Whether this organisation is running under HIPAA safeguards.
 *
 * Read by the things that have to behave differently — the read log, the
 * session timeout, the two-factor requirement. Cached nowhere on purpose: a
 * business that switches this on expects it to be on, and a stale cache would
 * mean the next few minutes of reads went unlogged.
 */
export async function hipaaSettings(organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.complianceSettings)
    .where(
      and(
        eq(schema.complianceSettings.organizationId, organizationId),
        eq(schema.complianceSettings.hipaa, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

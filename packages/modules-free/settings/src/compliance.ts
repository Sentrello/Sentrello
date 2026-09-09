import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import {
  forgetHipaaRules,
  record as recordSecurityEvent,
} from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { REGIMES, suggestedRegimes } from "./regimes";

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
/**
 * The regime list a request is asking for, or null where it is not asking.
 *
 * Only ids this build knows are kept. A regime removed in a later release, or
 * a typo, would otherwise sit in the column for ever and read as switched on.
 */
function settingsBefore(
  body: Record<string, unknown>,
  before: { regimes?: string[] } | undefined,
): string[] | null {
  if (!Array.isArray(body.regimes)) return null;
  const known = new Set(REGIMES.map((r) => r.id));
  return [...new Set(body.regimes.map(String).filter((id) => known.has(id)))];
}

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
      const chosen = new Set(settings?.regimes ?? []);

      /**
       * Everything on offer, with the chosen ones marked — rather than only
       * what is switched on.
       *
       * A business that starts selling into the EU has to be able to *find*
       * the thing it now needs, and a screen showing only what is already on
       * cannot tell them it exists. The cost of showing the rest is a few
       * paragraphs; the cost of hiding it is a business that does not know
       * what it is missing.
       */
      return c.json({
        settings,
        regimes: REGIMES.map((r) => ({
          id: r.id,
          label: r.label,
          where: r.where,
          when: r.when,
          turnsOn: r.turnsOn,
          chosen: chosen.has(r.id),
        })),
        /**
         * Only the obligations that follow from what they chose.
         *
         * A shop in Texas being shown five HIPAA duties learns to scroll past
         * this panel, and then misses the one that did apply. Relevance is what
         * makes a list like this get read.
         */
        yourOwnObligations: REGIMES.filter((r) => chosen.has(r.id)).flatMap(
          (r) =>
            r.yourJob.map((j) => ({
              regime: r.label,
              what: j.what,
              why: j.why,
              done:
                r.id === "hipaa" && j.what.startsWith("A written risk")
                  ? Boolean(settings?.riskAssessmentOn)
                  : null,
            })),
        ),
      });
    },
  );

  /**
   * What a business is likely to need, from two questions it can answer.
   *
   * Asked during setup, because the alternative is a settings screen nobody
   * opens until an authority writes to them. Two questions — where do you
   * operate, what do you do — and the answers are things anybody knows about
   * their own business without looking anything up.
   *
   * **Suggested, never applied.** The business knows what this cannot: whether
   * it clears the CCPA thresholds, whether it is a covered entity, whether one
   * German customer is worth the paperwork. This offers; they decide.
   */
  ctx.app.post(
    "/api/compliance/suggest",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const places = Array.isArray(body.places) ? body.places.map(String) : [];
      const sectors = Array.isArray(body.sectors)
        ? body.sectors.map(String)
        : [];
      const suggested = suggestedRegimes({ places, sectors });

      return c.json({
        suggested: REGIMES.filter((r) => suggested.includes(r.id)).map((r) => ({
          id: r.id,
          label: r.label,
          when: r.when,
        })),
        /**
         * What was not suggested, and why it is still on the screen.
         *
         * A business that reads "we did not suggest HIPAA because you are not
         * in health" has learned something. One that simply does not see it has
         * learned nothing, and will not think of it when they take on their
         * first medical client.
         */
        notSuggested: REGIMES.filter((r) => !suggested.includes(r.id)).map(
          (r) => ({ id: r.id, label: r.label, when: r.when }),
        ),
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

      /**
       * Refused rather than allowed and regretted.
       *
       * Switching on a rule that requires a second factor, without having one,
       * refuses you from every screen in the product — and the way back is the
       * screen you just used. The guard keeps this route reachable so nobody is
       * ever truly stuck, and this stops the situation arising at all, which is
       * better than a rescue.
       *
       * The message says what to do. "Forbidden" with no explanation, on the
       * click that caused it, is how somebody decides the safeguards are broken.
       */
      /**
       * The regime list is the input; `hipaa` follows from it.
       *
       * Two ways to say the same thing is two things to keep in step, and the
       * one that drifts is the one enforcing a safeguard.
       */
      let regimes = settingsBefore(body, before);
      if (regimes) {
        patch.regimes = regimes;
        patch.hipaa = regimes.includes("hipaa");
      }
      regimes = (patch.regimes as string[]) ?? before?.regimes ?? [];

      const wantsTwoFactor =
        body.requireTwoFactor === true ||
        (regimes.includes("hipaa") &&
          !before?.hipaa &&
          body.requireTwoFactor === undefined);
      const me = c.get("session")?.user as
        | { twoFactorEnabled?: boolean | null }
        | undefined;
      if (wantsTwoFactor && !me?.twoFactorEnabled) {
        return c.json(
          {
            error:
              "set up your own second factor first, in your profile — otherwise turning this on would lock you out of everything except this screen",
          },
          400,
        );
      }

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

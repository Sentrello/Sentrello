import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  DEFAULT_TAX_REGIMES,
  TAX_REGIMES,
  cleanTaxRegimes,
  setTaxRegimes,
  taxRegimesFor,
} from "@sentrello/db/tax-regimes";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * Which tax regimes this business operates in, alongside its other company
 * and tax settings. See `@sentrello/db/tax-regimes` for the catalogue and
 * what each one gates in the nav.
 */
export function registerTaxRegimes(ctx: ModuleContext) {
  ctx.app.get(
    "/api/tax-regimes",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      return c.json({
        regimes: TAX_REGIMES.map(({ id, label }) => ({ id, label })),
        chosen: await taxRegimesFor(orgId),
        default: DEFAULT_TAX_REGIMES,
      });
    },
  );

  ctx.app.put(
    "/api/tax-regimes",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const chosen = cleanTaxRegimes(body.regimes);
      if (chosen === null) {
        return c.json({ error: "regimes must be a list of regime ids" }, 400);
      }
      // Turning every regime off is allowed — it does not touch any filed
      // figure, it only empties the sidebar section. What it must never do is
      // silently commit a business to nothing when it meant to say something;
      // the screen this feeds asks for confirmation before saving an empty set.
      await setTaxRegimes(orgId, chosen);
      return c.json({ chosen });
    },
  );
}

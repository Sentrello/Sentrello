import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, eq, schema } from "@sentrello/db";
import { record as recordSecurityEvent } from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { secrets } from "@sentrello/module-sdk";
import {
  authoriseUrl,
  exchangeCode,
  obligations,
  refreshTokens,
  submitReturn,
} from "./mtd";
import type { ClientContext } from "./mtd-headers";
import { ledgerRows, periodFrom } from "./reports";
import { forHmrc, vatReturn } from "./vat-return";

/**
 * Filing a VAT return to HMRC, from the business's own instance.
 *
 * **Where the credentials come from, and why it is not the repository.** HMRC
 * registers the *software*, not each business — so the client id and secret are
 * ours and every instance uses the same pair. This repository is public, so
 * they arrive as environment variables and the feature is simply absent until
 * they are set. A secret committed to a public repository is a secret, once.
 *
 * A business that would rather use its own HMRC application can set these to
 * its own values, which is also the answer for anybody uneasy about a shared
 * vendor credential.
 */
function config() {
  const clientId = process.env.HMRC_CLIENT_ID;
  const clientSecret = process.env.HMRC_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    // The sandbox unless told otherwise. Filing a real return by accident is
    // the worse mistake of the two, so the safe end is the default.
    sandbox: process.env.HMRC_LIVE !== "true",
  };
}

/**
 * What the browser measured, off the request body.
 *
 * Passed as an argument rather than stashed on the request context: the context
 * is typed to what the platform puts there, and widening it so one module can
 * hide a value in it would make every module's contract vaguer.
 */
function clientContext(raw: unknown): ClientContext {
  const body = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    deviceId: str(body.deviceId),
    screens: str(body.screens),
    windowSize: str(body.windowSize),
    timezone: str(body.timezone),
    userAgent: str(body.userAgent),
  };
}

export function registerMtd(ctx: ModuleContext) {
  const connectionFor = async (orgId: string) => {
    const [row] = await db
      .select()
      .from(schema.mtdConnections)
      .where(eq(schema.mtdConnections.organizationId, orgId))
      .limit(1);
    return row ?? null;
  };

  /**
   * A usable access token, refreshing when it is stale.
   *
   * Refreshing is the normal path here, not the exception: tokens last four
   * hours and a business files four times a year, so every submission after the
   * first begins with one. The new refresh token is written back because HMRC
   * rotates it.
   */
  const usableToken = async (orgId: string) => {
    const cfg = config();
    const row = await connectionFor(orgId);
    if (!cfg || !row) return null;

    // A minute of margin: a token that expires mid-submission is a failed
    // filing, and the cost of refreshing early is nothing.
    if (new Date(row.expiresAt).getTime() - Date.now() > 60_000) {
      return { token: secrets.open(row.accessToken), row, cfg };
    }

    const fresh = await refreshTokens(cfg, secrets.open(row.refreshToken));
    const [updated] = await db
      .update(schema.mtdConnections)
      .set({
        accessToken: secrets.seal(fresh.accessToken),
        refreshToken: secrets.seal(fresh.refreshToken),
        expiresAt: new Date(fresh.expiresAt),
        updatedAt: new Date(),
      })
      .where(eq(schema.mtdConnections.organizationId, orgId))
      .returning();
    return { token: fresh.accessToken, row: updated ?? row, cfg };
  };

  ctx.app.get(
    "/api/accounting/mtd",
    requireSession(),
    requirePermission({ accounting: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const cfg = config();
      const row = await connectionFor(orgId);
      return c.json({
        /*
         * Said plainly rather than hidden. An instance without the credentials
         * cannot file, and a business staring at a button that does nothing is
         * worse off than one told the feature is not configured here.
         */
        available: Boolean(cfg),
        connected: Boolean(row),
        vrn: row?.vrn ?? null,
        sandbox: row?.sandbox ?? cfg?.sandbox ?? true,
        connectedAt: row?.connectedAt ?? null,
      });
    },
  );

  /** Where to send somebody to authorise. */
  ctx.app.post(
    "/api/accounting/mtd/authorise",
    requireSession(),
    requirePermission({ accounting: ["update"] }),
    async (c: RouteContext) => {
      const cfg = config();
      if (!cfg) {
        return c.json(
          { error: "this instance has no HMRC credentials configured" },
          400,
        );
      }
      /*
       * The state is checked when the code comes back. With an out-of-band
       * flow the person carries the code by hand, so state cannot prevent a
       * redirect being forged — what it does catch is a code pasted into the
       * wrong instance, which is a real thing somebody running two of these
       * will do.
       */
      const state = crypto.randomUUID();
      return c.json({ url: authoriseUrl(cfg, state), state });
    },
  );

  /**
   * The code they pasted, exchanged and stored.
   *
   * HMRC's codes last minutes, so this does the exchange immediately and says
   * which failure happened: an expired code means authorise again, a refused
   * one means the configuration is wrong, and from a screen they look the same.
   */
  ctx.app.post(
    "/api/accounting/mtd/finish",
    requireSession(),
    requirePermission({ accounting: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const cfg = config();
      if (!cfg) return c.json({ error: "no HMRC credentials here" }, 400);

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const code = String(body.code ?? "").trim();
      const vrn = String(body.vrn ?? "").replace(/\s/g, "");
      if (!code) return c.json({ error: "paste the code from HMRC" }, 400);
      // Nine digits. A wrong VRN files against somebody else's registration,
      // and a submission cannot be withdrawn.
      if (!/^\d{9}$/.test(vrn)) {
        return c.json({ error: "a VAT number is nine digits" }, 400);
      }

      let tokens: Awaited<ReturnType<typeof exchangeCode>>;
      try {
        tokens = await exchangeCode(cfg, code);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      await db
        .insert(schema.mtdConnections)
        .values({
          organizationId: orgId,
          vrn,
          accessToken: secrets.seal(tokens.accessToken),
          refreshToken: secrets.seal(tokens.refreshToken),
          expiresAt: new Date(tokens.expiresAt),
          sandbox: cfg.sandbox,
        })
        .onConflictDoUpdate({
          target: schema.mtdConnections.organizationId,
          set: {
            vrn,
            accessToken: secrets.seal(tokens.accessToken),
            refreshToken: secrets.seal(tokens.refreshToken),
            expiresAt: new Date(tokens.expiresAt),
            sandbox: cfg.sandbox,
            updatedAt: new Date(),
          },
        });

      return c.json({ connected: true, vrn, sandbox: cfg.sandbox });
    },
  );

  /** What HMRC says is due. */
  ctx.app.post(
    "/api/accounting/mtd/obligations",
    requireSession(),
    requirePermission({ accounting: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const ready = await usableToken(orgId);
      if (!ready) return c.json({ error: "not connected to HMRC" }, 400);

      const year = new Date().getFullYear();
      try {
        const out = await obligations(
          ready.cfg,
          ready.token,
          ready.row.vrn,
          String(body.from ?? `${year - 2}-01-01`),
          String(body.to ?? `${year}-12-31`),
          clientContext(body.client),
          await serverContext(c, orgId),
        );
        return c.json(out);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    },
  );

  /**
   * Submitting, which cannot be undone.
   *
   * The figures are recomputed here from the ledger rather than taken from the
   * request. A browser that posted its own boxes would be a browser able to
   * file a return that does not match the books — and the declaration the
   * person is agreeing to is that the figures are true and complete.
   */
  ctx.app.post(
    "/api/accounting/mtd/submit",
    requireSession(),
    requirePermission({ accounting: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const periodKey = String(body.periodKey ?? "");
      if (!periodKey) return c.json({ error: "which period?" }, 400);
      if (body.finalised !== true) {
        return c.json(
          { error: "the declaration has to be agreed to before filing" },
          400,
        );
      }

      const ready = await usableToken(orgId);
      if (!ready) return c.json({ error: "not connected to HMRC" }, 400);

      /*
       * The dates come from the obligation HMRC gave us, not from the browser's
       * idea of the quarter. A return filed for the wrong dates is arithmetic
       * over the wrong rows, and it is the sort of mistake nobody notices until
       * the next quarter does not add up.
       */
      const boxes = vatReturn(
        await ledgerRows(
          orgId,
          periodFrom((name) =>
            name === "from"
              ? String(body.from ?? "")
              : name === "to"
                ? String(body.to ?? "")
                : undefined,
          ),
        ),
      );

      try {
        const receipt = await submitReturn(
          ready.cfg,
          ready.token,
          ready.row.vrn,
          periodKey,
          forHmrc(boxes),
          true,
          clientContext(body.client),
          await serverContext(c, orgId),
        );

        /*
         * Recorded in the security log, because a VAT return is a declaration a
         * named person made and cannot withdraw. "Who filed this, and when" is
         * the question afterwards, and the receipt number is what HMRC will ask
         * for.
         */
        const session = c.get("session");
        await recordSecurityEvent({
          organizationId: orgId,
          actor: { id: session?.user?.id ?? "", name: session?.user?.name },
          action: "vat.filed",
          detail: {
            periodKey,
            vrn: ready.row.vrn,
            formBundleNumber: receipt.formBundleNumber,
            sandbox: ready.row.sandbox,
          },
        });

        return c.json({ receipt, boxes });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    },
  );

  /** Disconnecting, which forgets the tokens and nothing else. */
  ctx.app.delete(
    "/api/accounting/mtd",
    requireSession(),
    requirePermission({ accounting: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      await db
        .delete(schema.mtdConnections)
        .where(eq(schema.mtdConnections.organizationId, orgId));
      return c.json({ connected: false });
    },
  );
}

/**
 * What this server knows about the request.
 *
 * `Gov-Client-Public-IP` is the connecting client's address **as this server
 * sees it**, and behind a proxy that is the proxy. A self-hosted business
 * behind a load balancer sends their own infrastructure's address on every
 * submission unless the server is configured to read the forwarded header —
 * the same problem, and the same fix, as the real_ip work for Cloudflare.
 */
async function serverContext(c: RouteContext, orgId: string) {
  const session = c.get("session");
  const forwarded = c.req.header("x-forwarded-for") ?? "";
  const clientIp = forwarded.split(",")[0]?.trim() || undefined;

  return {
    clientIp,
    forwarded: forwarded || undefined,
    vendorIp: process.env.SENTRELLO_PUBLIC_IP,
    userId: session?.user?.id ?? "",
    productVersion: process.env.SENTRELLO_RELEASE ?? "0.0.0",
    licenceId: process.env.SENTRELLO_INSTANCE_ID ?? orgId,
    /*
     * Reported only where a second factor was actually used. A business signing
     * in with a password alone has nothing to report, and HMRC would rather the
     * header were absent than untrue.
     */
    multiFactor: (session?.user as { twoFactorEnabled?: boolean } | undefined)
      ?.twoFactorEnabled
      ? {
          type: "TOTP",
          timestamp: new Date().toISOString(),
          reference: session?.session?.id ?? "",
        }
      : undefined,
  };
}

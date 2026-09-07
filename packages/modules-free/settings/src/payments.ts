import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, asc, db, eq, schema } from "@sentrello/db";
import type { PaymentAccount } from "@sentrello/db/payments";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import {
  type Credentials,
  type PaymentProvider,
  paypalProvider,
  secrets,
  stripeProvider,
} from "@sentrello/module-sdk";

/**
 * Connecting a card processor, from a screen.
 *
 * The flow a business already knows from WooCommerce or Shopify: paste the
 * keys, press Test, see who you are connected to, take a payment in the
 * sandbox until it looks right, then turn on live. Nobody edits a file on a
 * server, which is the whole point — the previous answer to "how do I take
 * card payments for an invoice" was three environment variables and a restart.
 *
 * One connection for the instance rather than one per module. A business has a
 * Stripe account, not a Stripe account for invoices and another for the shop,
 * and asking somebody to paste the same keys twice is asking them to get one
 * of the two wrong.
 *
 * Secrets are sealed before they are stored and never come back out of any
 * route in any shape. A screen gets the last four characters, which is enough
 * for somebody to recognise their own key and useless to anybody else.
 */

const PROVIDERS = new Set(["stripe", "paypal"]);
const MODES = new Set(["test", "live"]);

/** Builds a provider from a stored row, opening its secrets. */
export function providerFrom(account: PaymentAccount): PaymentProvider {
  const credentials: Credentials = {
    publicKey: account.publicKey,
    secretKey: account.secretKey ? secrets.open(account.secretKey) : "",
    webhookSecret: account.webhookSecret
      ? secrets.open(account.webhookSecret)
      : null,
    test: account.mode === "test",
  };
  return account.provider === "paypal"
    ? paypalProvider(credentials)
    : stripeProvider(credentials);
}

/** What a settings screen may see: everything except the secrets. */
function forDisplay(account: PaymentAccount) {
  return {
    id: account.id,
    provider: account.provider,
    mode: account.mode,
    publicKey: account.publicKey,
    secretHint: account.secretHint,
    hasWebhookSecret: account.webhookSecret !== null,
    enabled: account.enabled,
    lastTestedAt: account.lastTestedAt,
    lastTestOk: account.lastTestOk,
    lastTestMessage: account.lastTestMessage,
    accountLabel: account.accountLabel,
  };
}

/**
 * The environment keys an instance falls back to when nothing is connected.
 *
 * Pro reads `STRIPE_SECRET_KEY` when this organization has no enabled Stripe
 * row, deliberately: an instance taking payments yesterday on an environment
 * variable must keep taking them today. The cost is that it is silent, and on
 * 2026-09-05 that silence meant an instance was charging cards into a
 * different company's Stripe account for weeks with nothing on any screen
 * saying so. Nobody had done anything wrong; there was simply nowhere to see
 * it.
 *
 * So the screen says it. Not an error — the fallback is doing its job — but a
 * statement of which account the money would actually reach, named rather than
 * hinted at, because "an environment variable is in use" tells nobody whether
 * it is the right one.
 */
export interface EnvironmentFallback {
  provider: "stripe";
  /** Which account the key belongs to, as Stripe names it. */
  account: string | null;
  /** Last four, the same courtesy a stored key gets. */
  hint: string;
  live: boolean;
}

/**
 * Asking Stripe who a key belongs to costs a round trip, and this is read on
 * every visit to the settings screen — including a refetch when the window
 * regains focus. One answer a minute is plenty for something that changes when
 * somebody edits a file on a server.
 */
let named: { at: number; hint: string; account: string | null } | null = null;

export async function environmentFallback(
  orgId: string,
): Promise<EnvironmentFallback | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;

  // A connection somebody saved wins, and while one is enabled the environment
  // is never read — so there is nothing to warn about.
  const [enabled] = await db
    .select({ id: schema.paymentAccounts.id })
    .from(schema.paymentAccounts)
    .where(
      and(
        eq(schema.paymentAccounts.organizationId, orgId),
        eq(schema.paymentAccounts.provider, "stripe"),
        eq(schema.paymentAccounts.enabled, true),
      ),
    )
    .limit(1);
  if (enabled) return null;

  const hint = key.slice(-4);
  const fresh = named && named.hint === hint && Date.now() - named.at < 60_000;
  if (!fresh) {
    const result = await stripeProvider({
      publicKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
      secretKey: key,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
      test: !key.startsWith("sk_live"),
    })
      .testConnection()
      // A key Stripe will not answer for is still a key in use. Say the rest
      // and leave the account unnamed rather than saying nothing at all.
      .catch(() => ({ ok: false, label: undefined }) as const);
    named = {
      at: Date.now(),
      hint,
      account: ("label" in result ? result.label : null) ?? null,
    };
  }

  return {
    provider: "stripe",
    account: named?.account ?? null,
    hint,
    live: key.startsWith("sk_live"),
  };
}

async function accountFor(
  orgId: string,
  provider: string,
  mode: string,
): Promise<PaymentAccount | null> {
  const [row] = await db
    .select()
    .from(schema.paymentAccounts)
    .where(
      and(
        eq(schema.paymentAccounts.organizationId, orgId),
        eq(schema.paymentAccounts.provider, provider),
        eq(schema.paymentAccounts.mode, mode),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function registerPaymentAccounts(ctx: ModuleContext) {
  ctx.app.get(
    "/api/payments/accounts",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.paymentAccounts)
        .where(eq(schema.paymentAccounts.organizationId, orgId))
        .orderBy(asc(schema.paymentAccounts.provider));

      return c.json({
        accounts: rows.map(forDisplay),
        // An instance with no secret at all cannot store credentials, and
        // saying so here is better than a crypto error on save.
        canStoreSecrets: secrets.secretsAvailable(),
        environmentFallback: await environmentFallback(orgId),
      });
    },
  );

  /**
   * Saving keys.
   *
   * A field left blank keeps what is stored, so somebody changing only the
   * webhook secret does not have to paste the API key again — they cannot read
   * it back to check it.
   */
  ctx.app.put(
    "/api/payments/accounts/:provider/:mode",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const provider = c.req.param("provider") ?? "";
      const mode = c.req.param("mode") ?? "";
      if (!PROVIDERS.has(provider) || !MODES.has(mode)) {
        return c.json({ error: "no such connection" }, 404);
      }
      if (!secrets.secretsAvailable()) {
        return c.json(
          {
            error:
              "this instance has no secret configured, so credentials cannot be stored",
          },
          409,
        );
      }

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const existing = await accountFor(orgId, provider, mode);

      const secretKey =
        typeof body.secretKey === "string" && body.secretKey.trim()
          ? body.secretKey.trim()
          : null;
      const webhookSecret =
        typeof body.webhookSecret === "string" && body.webhookSecret.trim()
          ? body.webhookSecret.trim()
          : null;

      const values = {
        organizationId: orgId,
        provider,
        mode,
        publicKey:
          typeof body.publicKey === "string"
            ? body.publicKey.trim() || null
            : (existing?.publicKey ?? null),
        secretKey: secretKey
          ? secrets.seal(secretKey)
          : (existing?.secretKey ?? null),
        secretHint: secretKey
          ? secrets.hint(secretKey)
          : (existing?.secretHint ?? null),
        webhookSecret: webhookSecret
          ? secrets.seal(webhookSecret)
          : (existing?.webhookSecret ?? null),
        // Changed keys are unproven keys: whatever the last test said, it was
        // about something else.
        lastTestOk: secretKey ? null : (existing?.lastTestOk ?? null),
        lastTestMessage: secretKey ? null : (existing?.lastTestMessage ?? null),
        lastTestedAt: secretKey ? null : (existing?.lastTestedAt ?? null),
        updatedAt: new Date(),
      };

      const [saved] = existing
        ? await db
            .update(schema.paymentAccounts)
            .set(values)
            .where(eq(schema.paymentAccounts.id, existing.id))
            .returning()
        : await db.insert(schema.paymentAccounts).values(values).returning();
      if (!saved) throw new Error("payment account save returned no row");

      // Keys that no longer prove anything must not stay switched on.
      if (secretKey && saved.enabled) {
        await db
          .update(schema.paymentAccounts)
          .set({ enabled: false })
          .where(eq(schema.paymentAccounts.id, saved.id));
        saved.enabled = false;
      }

      return c.json({ account: forDisplay(saved) });
    },
  );

  /** Asks the processor whether these keys work, and who they belong to. */
  ctx.app.post(
    "/api/payments/accounts/:provider/:mode/test",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const account = await accountFor(
        orgId,
        c.req.param("provider") ?? "",
        c.req.param("mode") ?? "",
      );
      if (!account) return c.json({ error: "nothing is stored yet" }, 404);

      let result: { ok: boolean; message: string; label?: string };
      try {
        result = await providerFrom(account).testConnection();
      } catch (err) {
        // A network failure is not a wrong key, and saying so saves somebody
        // pasting a perfectly good key three more times.
        result = {
          ok: false,
          message: `could not reach the processor: ${(err as Error).message}`,
        };
      }

      const [updated] = await db
        .update(schema.paymentAccounts)
        .set({
          lastTestedAt: new Date(),
          lastTestOk: result.ok,
          lastTestMessage: result.message,
          accountLabel: result.label ?? account.accountLabel,
        })
        .where(eq(schema.paymentAccounts.id, account.id))
        .returning();

      return c.json({
        result,
        account: updated ? forDisplay(updated) : forDisplay(account),
      });
    },
  );

  /**
   * Turning a connection on.
   *
   * Only one at a time, and only one that has been tested. An instance
   * switched to live on untested keys is one whose first real customer sees an
   * error at the moment they try to pay.
   */
  ctx.app.post(
    "/api/payments/accounts/:provider/:mode/enable",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const account = await accountFor(
        orgId,
        c.req.param("provider") ?? "",
        c.req.param("mode") ?? "",
      );
      if (!account) return c.json({ error: "nothing is stored yet" }, 404);
      if (!account.secretKey) {
        return c.json({ error: "no keys are stored for that" }, 400);
      }
      if (!account.lastTestOk) {
        return c.json(
          { error: "test the connection before turning it on" },
          409,
        );
      }
      if (!account.webhookSecret) {
        // Without it no payment is ever confirmed, and every invoice sits
        // unpaid while the money has actually been taken. Better refused here.
        return c.json(
          {
            error:
              "a webhook secret is needed, or payments will never be confirmed",
          },
          409,
        );
      }

      await db
        .update(schema.paymentAccounts)
        .set({ enabled: false })
        .where(eq(schema.paymentAccounts.organizationId, orgId));
      const [enabled] = await db
        .update(schema.paymentAccounts)
        .set({ enabled: true })
        .where(eq(schema.paymentAccounts.id, account.id))
        .returning();

      return c.json({ account: enabled ? forDisplay(enabled) : null });
    },
  );

  /** Turning everything off. The instance stops taking cards and says so. */
  ctx.app.post(
    "/api/payments/accounts/disable",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      await db
        .update(schema.paymentAccounts)
        .set({ enabled: false })
        .where(eq(schema.paymentAccounts.organizationId, orgId));
      return c.json({ ok: true });
    },
  );

  ctx.app.delete(
    "/api/payments/accounts/:provider/:mode",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const account = await accountFor(
        orgId,
        c.req.param("provider") ?? "",
        c.req.param("mode") ?? "",
      );
      if (!account) return c.json({ error: "not found" }, 404);

      await db
        .delete(schema.paymentAccounts)
        .where(eq(schema.paymentAccounts.id, account.id));
      return c.json({ ok: true });
    },
  );
}

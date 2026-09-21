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
import { unclaimedPaymentEvents } from "./payment-webhook";

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

/**
 * Whether the processor is sending this instance's events to this instance.
 *
 * Separate from the route because the sentence a business reads here is the
 * whole value of the check: "connected" while every payment goes to an
 * address that no longer exists is the failure this exists to name, and it
 * has to say *where* they are going or the fix is a guess.
 */
export function webhookVerdict(
  ourUrl: string,
  targets: { url: string; status: string }[],
): { step: string; ok: boolean; detail?: string } {
  const step = "checked where events are sent";
  if (targets.some((t) => t.url === ourUrl && t.status === "enabled")) {
    return { step, ok: true };
  }
  if (targets.length === 0) {
    return {
      step,
      ok: false,
      detail: `nothing at the processor sends events to ${ourUrl} — payments would be taken and never confirmed`,
    };
  }
  return {
    step,
    ok: false,
    detail: `events go to ${targets
      .map((t) => t.url)
      .join(
        ", ",
      )}, not to ${ourUrl} — clear the stored signing secret and connect again to fix it`,
  };
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
        /*
         * Events the processor sent that nothing on this instance recognised.
         *
         * Here because this is the screen somebody opens when payments are
         * behaving strangely, and because the failure that made this list
         * necessary — an invoice paid by card, confirmed by nobody — looked
         * from every screen exactly like nothing having happened.
         */
        unclaimedEvents: await unclaimedPaymentEvents(orgId),
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

  /**
   * Connecting a processor, in one press.
   *
   * The old shape was three buttons in an order nobody was told: save the
   * keys, test them, turn it on. Every pair of steps had a state in between
   * that looks broken — keys saved but untested, tested but not on — and the
   * error somebody actually hit was being told a webhook secret was needed
   * while it sat unsaved in the box in front of them.
   *
   * It is one action because it is one intention. Paste the keys, press
   * connect. Each stage reports what happened, and the first one to fail stops
   * the rest: a processor is never switched on because a later step papered
   * over an earlier one.
   *
   * **The webhook sets itself up.** Stripe can be asked to register an
   * endpoint and hands back the signing secret, so the worst part of
   * connecting a processor — go to another company's dashboard, find webhooks,
   * paste a URL, pick the right events out of two hundred, copy a secret
   * back — is simply gone. Where it cannot be done, which is any instance a
   * processor cannot reach, the screen asks for the secret by hand and says
   * why.
   */
  ctx.app.post(
    "/api/payments/accounts/:provider/:mode/connect",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const provider = c.req.param("provider") ?? "";
      const mode = c.req.param("mode") ?? "";
      const account = await accountFor(orgId, provider, mode);

      if (!account?.secretKey) {
        return c.json({ error: "paste the keys first" }, 400);
      }

      const steps: { step: string; ok: boolean; detail?: string }[] = [];
      /*
       * The stages are the answer, and they travel in the failure as well as
       * the success — a caller that only reads `error` still gets the sentence
       * that matters rather than a status code to guess from.
       */
      const stop = (status: 400 | 409 | 503) => {
        const failed = steps.find((s) => !s.ok);
        return c.json(
          {
            steps,
            error: failed?.detail ?? `could not ${failed?.step ?? "connect"}`,
            account: forDisplay(account),
          },
          status,
        );
      };

      let live: PaymentProvider;
      try {
        live = providerFrom(account);
      } catch (err) {
        steps.push({
          step: "read the stored keys",
          ok: false,
          detail: (err as Error).message,
        });
        return stop(503);
      }

      const tested = await live.testConnection().catch((err: Error) => ({
        ok: false,
        message: `could not reach the processor: ${err.message}`,
      }));
      steps.push({
        step: "check the keys with the processor",
        ok: tested.ok,
        detail: tested.message,
      });
      await db
        .update(schema.paymentAccounts)
        .set({
          lastTestedAt: new Date(),
          lastTestOk: tested.ok,
          lastTestMessage: tested.message,
          accountLabel:
            ("label" in tested ? tested.label : null) ?? account.accountLabel,
        })
        .where(eq(schema.paymentAccounts.id, account.id));
      if (!tested.ok) return stop(409);

      /*
       * Already stored means somebody pasted one deliberately — for an
       * instance the processor cannot reach, or an endpoint they manage
       * themselves. Replacing it would break their setup to save a step they
       * had already taken.
       *
       * But a stored secret proves only that an endpoint was set up once. It
       * does not prove the endpoint still exists, or still points here: this
       * product's webhook address moved from one module's path to the
       * platform's, and the endpoint registered under the old one stayed
       * enabled at Stripe, answering 404 to every delivery. Money taken,
       * orders never confirmed, and nothing on either side saying so — found
       * on the demo on 21 September, where a sandbox purchase succeeded at
       * Stripe and the order sat unpaid.
       *
       * So a stored secret is kept and checked: if the processor is not
       * sending events to this instance's address, the step says so and names
       * where they are going instead.
       */
      let webhookSecret = account.webhookSecret;
      const ourWebhook = `${
        process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin
      }/api/payments/webhook/${provider}`;
      /*
       * And whether the events that do arrive are being accepted.
       *
       * The URL being right is half the question. A signing secret that
       * belongs to an endpoint somebody replaced is the other half, and it
       * looks identical from here: the processor delivers, this instance
       * answers 401, every payment is taken and never confirmed. The webhook
       * route counts those refusals; this is where somebody is told.
       */
      if (account.webhookRejectedCount > 0) {
        const since = account.webhookAcceptedAt;
        steps.push({
          step: "checked the events that arrived",
          ok: false,
          detail: `${account.webhookRejectedCount} event(s) were refused as unsigned or wrongly signed${
            since
              ? `, the last one accepted ${since.toDateString()}`
              : " and none has ever been accepted"
          } — the stored signing secret does not belong to the endpoint sending them. Clear it and connect again.`,
        });
      }

      if (webhookSecret && live.webhookTargets) {
        try {
          steps.push(webhookVerdict(ourWebhook, await live.webhookTargets()));
        } catch {
          // Asking failed, which is not the same as the answer being no.
          steps.push({
            step: "checked where events are sent",
            ok: true,
            detail: "could not ask the processor; left as it is",
          });
        }
      }
      if (!webhookSecret && live.ensureWebhook) {
        try {
          /*
           * The platform's endpoint, not one module's.
           *
           * This line used to name the shop's handler, which is why an invoice
           * paid by card was never confirmed: the event arrived somewhere that
           * did not recognise it. The address now belongs to the platform and
           * every module that declared itself hears from it.
           */
          const made = await live.ensureWebhook(ourWebhook);
          if (made) {
            webhookSecret = secrets.seal(made.secret);
            await db
              .update(schema.paymentAccounts)
              .set({ webhookSecret })
              .where(eq(schema.paymentAccounts.id, account.id));
            steps.push({ step: "set up the webhook", ok: true });
          } else {
            steps.push({
              step: "set up the webhook",
              ok: false,
              detail:
                "this instance has no address the processor can reach, so the signing secret has to be pasted in by hand",
            });
          }
        } catch (err) {
          steps.push({
            step: "set up the webhook",
            ok: false,
            detail: (err as Error).message,
          });
        }
      }

      if (!webhookSecret) {
        // Refused rather than switched on: without it money is taken and no
        // order is ever confirmed, which is the worst failure this screen has.
        return stop(409);
      }

      await db
        .update(schema.paymentAccounts)
        .set({ enabled: false })
        .where(eq(schema.paymentAccounts.organizationId, orgId));
      const [enabled] = await db
        .update(schema.paymentAccounts)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(schema.paymentAccounts.id, account.id))
        .returning();
      steps.push({ step: "start taking payments", ok: true });

      return c.json({
        steps,
        account: enabled ? forDisplay(enabled) : forDisplay(account),
      });
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

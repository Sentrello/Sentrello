import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { mailConfigured } from "@sentrello/email";
import {
  setTelemetryEnabled,
  telemetryEnabled,
  telemetryFixedInEnvironment,
} from "@sentrello/jobs";
import {
  isValidLicenseKey,
  keyIsFromEnvironment,
  licenseKey,
  storeLicenseKey,
} from "@sentrello/licensing-client";
import { defineModule } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { registerPaymentAccounts } from "./payments";
import {
  agentPresent,
  canCheckForUpdates,
  checkForUpdates,
  currentVersion,
  isNewer,
  latestVersion,
  managedExternally,
  readStatus,
  requestRollback,
  requestSync,
  requestUpdate,
  rollbackTarget,
} from "./updates";

/**
 * What this instance is, and what it is wired up to.
 *
 * The questions a business owner cannot otherwise answer without an SSH
 * session: is my licence current, can I take card payments yet, where do I
 * point Stripe, does email work. All of that lived only in environment
 * variables, which is fine for the person who installed it and useless for
 * the person running the business a year later.
 *
 * Reports whether a secret is *set*, never what it is. A settings page that
 * echoes an API key is a settings page that leaks one over a shoulder, into a
 * screenshot, or through a support request.
 */
function configured(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

/**
 * The tax number, the way a tax number should leave the server.
 *
 * It is an EIN, an SSN, a VAT number — an identifier that follows the business
 * everywhere and is worth stealing on its own. It has to reach an invoice, and
 * it does, rendered on the server from the stored value. It does not have to
 * reach the settings screen, so it does not: the browser is shown the last four
 * characters and nothing else, and a save that hands the mask straight back
 * leaves the stored value alone.
 */
export function maskTaxId(value: string | null | undefined): string {
  if (!value) return "";
  const tail = value.slice(-4);
  if (value.length <= 4) return tail;
  return `${"\u2022".repeat(Math.min(value.length - 4, 12))}${tail}`;
}

export default defineModule({
  id: "settings",
  tier: "free",
  register(ctx) {
    ctx.registerNav({
      id: "settings",
      icon: "settings",
      label: "Settings",
      order: 90,
      group: "Configure",
      requires: { settings: ["read"] },
    });
    /**
     * Its pages, as pages.
     *
     * It was one screen with nine cards on it: the business's own name beside
     * a webhook URL beside a rollback button. Somebody looking for their VAT
     * number read past the licence to find it, and somebody applying an update
     * scrolled past the address. The rest of the product puts its screens in
     * the sidebar, so these go there too.
     */
    for (const page of [
      { id: "settings-business", label: "Your business", icon: "building" },
      { id: "settings-integrations", label: "Connections", icon: "at-sign" },
      { id: "settings-licence", label: "Licence and updates", icon: "key" },
      { id: "settings-modules", label: "Modules", icon: "boxes" },
    ].entries()) {
      ctx.registerNav({
        ...page[1],
        // Beside its parent: `order` sorts the whole nav, not each module.
        order: 90 + (page[0] + 1) / 100,
        parent: "settings",
        group: "Configure",
        requires: { settings: ["read"] },
      });
    }
    for (const p of ["read", "update"]) {
      ctx.registerPermission(`settings:${p}`);
    }

    registerPaymentAccounts(ctx);

    ctx.app.get(
      "/api/settings",
      requireSession(),
      requirePermission({ settings: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [org] = await db
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);

        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;

        return c.json({
          business: {
            name: org?.name ?? "",
            slug: org?.slug ?? "",
            address: org?.address ?? "",
            // Masked, never the value. See `maskTaxId`.
            taxId: maskTaxId(org?.taxId),
            taxIdLabel: org?.taxIdLabel ?? "",
            paymentInstructions: org?.paymentInstructions ?? "",
          },
          instance: {
            baseUrl: base,
            // Whether the address the instance thinks it has matches the one
            // being used. A mismatch is why payment links and portal links
            // arrive pointing at localhost.
            baseUrlMatchesRequest: base === new URL(c.req.url).origin,
          },
          email: {
            // Both, because an instance sending through its own SMTP server
            // was being told mail was not set up — and the overdue chase,
            // password resets and every invoice email depend on this answer.
            configured: mailConfigured(),
            from: process.env.EMAIL_FROM ?? null,
          },
          telemetry: {
            enabled: await telemetryEnabled(),
            // Fixed on the server: the toggle is shown, and shown as not
            // yours to change here, rather than silently failing to save.
            fixedOnServer: telemetryFixedInEnvironment(),
          },
          payments: {
            stripe: {
              configured: configured("STRIPE_SECRET_KEY"),
              webhookConfigured: configured("STRIPE_WEBHOOK_SECRET"),
              testMode: (process.env.STRIPE_SECRET_KEY ?? "").startsWith(
                "sk_test_",
              ),
              invoiceWebhookUrl: `${base}/api/webhooks/stripe/invoices`,
              shopWebhookUrl: `${base}/api/shop/webhook/stripe`,
            },
            paypal: {
              configured:
                configured("PAYPAL_CLIENT_ID") &&
                configured("PAYPAL_CLIENT_SECRET"),
              webhookConfigured: configured("PAYPAL_WEBHOOK_ID"),
              environment: process.env.PAYPAL_ENV ?? "sandbox",
              shopWebhookUrl: `${base}/api/shop/webhook/paypal`,
            },
          },
        });
      },
    );

    /** Renaming the business. It appears on every page a customer sees. */
    /**
     * Turning the usage report on or off after installation.
     *
     * The question is put once at install time, and this is where somebody
     * changes their mind — which they must be able to do without editing a
     * dotfile on their own server, or the opt-in is only nominally a choice.
     */
    ctx.app.post(
      "/api/settings/telemetry",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        if (telemetryFixedInEnvironment()) {
          return c.json(
            { error: "This is set on the server and cannot be changed here." },
            400,
          );
        }
        const body = (await c.req.json().catch(() => ({}))) as {
          enabled?: unknown;
        };
        try {
          await setTelemetryEnabled(body.enabled === true);
        } catch (err) {
          // A preference that cannot be written is a read-only or misplaced
          // data directory — which the person reading this can fix, but only
          // if they are told rather than shown a 500.
          return c.json(
            {
              error: `Could not save that: ${(err as Error).message}. The data directory may be read-only.`,
            },
            500,
          );
        }
        return c.json({ enabled: await telemetryEnabled() });
      },
    );

    /**
     * What version this is, and whether there is a newer one.
     *
     * Behind the read permission rather than public: it names the release an
     * instance runs, which is the first thing anyone probing for a known
     * vulnerability wants to know.
     */
    ctx.app.get(
      "/api/settings/updates",
      requireSession(),
      requirePermission({ settings: ["read"] }),
      async (c) => {
        const current = currentVersion();
        const latest = await latestVersion();

        return c.json({
          current,
          latest,
          rollbackTo: await rollbackTarget(),
          updateAvailable: latest !== null && isNewer(latest, current),
          /**
           * Whether this instance can go and ask.
           *
           * A Free instance is not told anything until somebody presses for
           * it: it holds no licence to identify itself with, and making one
           * phone home merely for opening a screen would break the promise
           * that it never does. Pressing is asking, and asking is fine.
           */
          canCheck: canCheckForUpdates(),
          // Without an agent the button would write a file nobody reads, so
          // the screen needs to know to explain instead of offering.
          canApply: await agentPresent(),
          /**
           * Somebody else owns this instance's version.
           *
           * Sentrello's own hosts run an image a deploy script builds, with
           * the control plane inside it. Updating from here would swap it for
           * the public Core image and take the licence server down with it.
           */
          managedExternally: managedExternally(),
          status: await readStatus(),
        });
      },
    );

    /**
     * Go and find out whether there is a newer release.
     *
     * A separate press rather than part of the screen above, because for a
     * Free instance this is the one moment it talks to us at all. Behind the
     * update permission, not read: whoever decides to look is whoever decides
     * to apply, and staff hold read so they can check whether email works.
     */
    ctx.app.post(
      "/api/settings/updates/check",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const current = currentVersion();
        const latest = await checkForUpdates();

        if (!latest) {
          return c.json(
            {
              error:
                "could not reach sentrello.com to check. Releases are also listed on GitHub.",
            },
            503,
          );
        }
        return c.json({
          current,
          latest,
          updateAvailable: isNewer(latest, current),
        });
      },
    );

    /**
     * Ask the host to put the previous release back.
     *
     * Guarded like the update it undoes. The version is not taken from the
     * request body: it is whatever the host recorded when it updated, so a
     * form cannot ask this instance to run some other release.
     */
    ctx.app.post(
      "/api/settings/rollback",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const target = await rollbackTarget();
        if (!target) {
          return c.json(
            { error: "there is no earlier version to go back to" },
            409,
          );
        }
        if (!(await agentPresent())) {
          return c.json(
            {
              error:
                "this instance has no update agent, so it cannot roll itself back. Run `sentrello rollback` on the server.",
            },
            409,
          );
        }

        await requestRollback(target);
        return c.json({ status: await readStatus() }, 202);
      },
    );

    /**
     * Enter a licence key, for someone upgrading from Free.
     *
     * The alternative was SSH into your own server and edit a dotfile at the
     * moment you hand over money, which is not a purchase experience.
     *
     * The key is validated to the exact shape we issue before it is stored,
     * because it ends up on a command line: `sentrello update` interpolates it
     * into a curl argument that runs as root on the customer's machine. Until
     * this endpoint existed the value came from a file an operator wrote by
     * hand, and the question never arose.
     */
    ctx.app.post(
      "/api/settings/license",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const body = await c.req.json().catch(() => ({}) as { key?: string });
        const key = typeof body.key === "string" ? body.key.trim() : "";

        if (!isValidLicenseKey(key.toUpperCase())) {
          // Deliberately says nothing about which part is wrong: this is the
          // shape of the key, not whether it is real, and hinting at the
          // difference helps someone guessing at keys.
          return c.json(
            { error: "that does not look like a Sentrello licence key" },
            400,
          );
        }

        if (keyIsFromEnvironment()) {
          // A key set on the server is the more privileged of the two and must
          // not be silently replaced from a browser.
          return c.json(
            {
              error:
                "this instance's licence key is set on the server. Change it there.",
            },
            409,
          );
        }

        await storeLicenseKey(key);

        // Stored is not the same as working: the key still has to be accepted
        // by the licence server before any paid feature appears. Ask the host
        // to go and find out rather than leaving the owner watching a screen
        // that has not changed.
        const canSync = await agentPresent();
        if (canSync) await requestSync();

        return c.json({ stored: true, syncing: canSync });
      },
    );

    /**
     * Fetch a fresh licence token and the bundles it entitles.
     *
     * What someone presses after buying a module on the website. Without it the
     * purchase appears whenever the daily refresh next runs — up to a day after
     * paying, which feels like it did not work.
     */
    ctx.app.post(
      "/api/settings/sync",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        if (!(await licenseKey())) {
          return c.json({ error: "this instance has no licence key yet" }, 409);
        }
        if (!(await agentPresent())) {
          return c.json(
            {
              error:
                "this instance cannot sync itself. Run `sentrello activate` on the server.",
            },
            409,
          );
        }
        await requestSync();
        return c.json({ status: await readStatus() }, 202);
      },
    );

    /**
     * Ask the host to update.
     *
     * `settings: ["update"]` rather than read: replacing the running version
     * is the most consequential button in the product, and staff have the read
     * permission so they can see whether email works.
     */
    ctx.app.post(
      "/api/settings/updates",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const current = currentVersion();
        // Asked again here rather than trusting the number the screen sent:
        // this is what decides which release a business is moved to, and a
        // version arriving in a request body is a version somebody could
        // choose for them.
        const latest = await checkForUpdates();

        if (!latest) {
          return c.json(
            {
              error: "could not reach the licence server to check for updates",
            },
            503,
          );
        }
        if (managedExternally()) {
          // Refused here as well as hidden on the screen: this is the request
          // that would replace a host's whole image, and a hidden button is
          // not a guard.
          return c.json(
            {
              error:
                "this instance's version is managed by its deploy, not from here",
            },
            409,
          );
        }
        if (!isNewer(latest, current)) {
          // Not an error worth alarming anyone with, but not a no-op either:
          // saying so beats a spinner that resolves into nothing.
          return c.json({ error: `already running ${current}` }, 409);
        }
        if (!(await agentPresent())) {
          return c.json(
            {
              error:
                "this instance has no update agent, so it cannot update itself. Run `sentrello update` on the server.",
            },
            409,
          );
        }

        await requestUpdate(latest);
        return c.json({ status: await readStatus() }, 202);
      },
    );

    ctx.app.put(
      "/api/settings",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = await c.req.json().catch(() => ({}));

        const name = String(body.name ?? "").trim();
        if (!name) return c.json({ error: "a name is required" }, 400);
        if (name.length > 120) {
          return c.json({ error: "that name is too long" }, 400);
        }

        // These reach customers on every invoice, so they are bounded rather
        // than trusted: an address is a few lines, not a document.
        const text = (value: unknown, limit: number, field: string) => {
          const trimmed = String(value ?? "").trim();
          if (trimmed.length > limit) throw new RangeError(field);
          return trimmed || null;
        };

        let address: string | null;
        let taxId: string | null;
        let taxIdLabel: string | null;
        let paymentInstructions: string | null;
        try {
          address = text(body.address, 500, "address");
          taxId = text(body.taxId, 60, "tax number");
          taxIdLabel = text(body.taxIdLabel, 40, "tax number label");
          paymentInstructions = text(
            body.paymentInstructions,
            800,
            "payment instructions",
          );
        } catch (err) {
          if (err instanceof RangeError) {
            return c.json({ error: `that ${err.message} is too long` }, 400);
          }
          throw err;
        }

        /**
         * The screen was shown a mask, so it can only send one back.
         *
         * Saving an address must not wipe the tax number, and a form that
         * round-trips what it was given would do exactly that. The mask coming
         * back unchanged means "leave it"; anything else is a new number.
         */
        const [before] = await db
          .select({ taxId: schema.organizations.taxId })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);
        if (taxId !== null && taxId === maskTaxId(before?.taxId)) {
          taxId = before?.taxId ?? null;
        }

        const [org] = await db
          .update(schema.organizations)
          .set({ name, address, taxId, taxIdLabel, paymentInstructions })
          .where(eq(schema.organizations.id, orgId))
          .returning();
        return c.json({
          business: {
            name: org?.name,
            slug: org?.slug,
            address: org?.address ?? "",
            taxId: maskTaxId(org?.taxId),
            taxIdLabel: org?.taxIdLabel ?? "",
            paymentInstructions: org?.paymentInstructions ?? "",
          },
        });
      },
    );
  },
});

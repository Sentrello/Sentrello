import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import {
  MARKET_CURRENCIES,
  baseCurrencyLocked,
  setBaseCurrency,
} from "@sentrello/db/currency";
import { asFlag, asTextOrNothing } from "@sentrello/db/request-values";
import { asText } from "@sentrello/db/text-columns";
import { knownTimezone } from "@sentrello/db/timezone";
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
import { defineModule, publicBodyLimit } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { registerCompliance } from "./compliance";
import { registerEvidence } from "./evidence";
import {
  MAX_WEBHOOK_BYTES,
  registerPaymentWebhookEndpoint,
} from "./payment-webhook";
import { registerPaymentAccounts } from "./payments";
import { registerPrivacy } from "./privacy";
import { registerTaxRegimes } from "./tax-regimes";
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
    /*
     * A processor reporting that money moved, with a bound on how much it may
     * say while doing it.
     *
     * The handler already refuses a body over this number — it has to read the
     * raw bytes to check the signature over them — and this is the same number
     * said a step earlier, so the stream is abandoned rather than buffered on a
     * request that was never going to verify.
     */
    ctx.app.use("/api/payments/webhook/*", publicBodyLimit(MAX_WEBHOOK_BYTES));

    registerPrivacy(ctx);
    registerCompliance(ctx);
    registerEvidence(ctx);
    registerTaxRegimes(ctx);
    /**
     * The one setting nothing else can guess.
     *
     * A business has no timezone until somebody fills it in, and until then
     * every question of the form "has nine o'clock come round" is answered in
     * UTC — which is the only safe assumption and is wrong for almost
     * everybody. It decides when a happy hour starts, when the till's day rolls
     * over, when a scheduled job runs, and which day an hour worked lands on.
     *
     * A checklist step rather than a field somebody may never open, because the
     * cost of leaving it is invisible: nothing breaks, prices and reports are
     * simply out by the offset and nobody has a reason to look at this screen.
     *
     * Asked of the data like every other step, so a business that set it during
     * install never sees it, and one that clears it sees it come back.
     */
    ctx.registerOnboarding({
      id: "settings",
      label: "Your business",
      icon: "building",
      requires: { settings: ["read"] },
      steps: [
        {
          id: "timezone",
          label: "Say where your business keeps its day",
          detail:
            "Your timezone decides when a timed offer starts, when the till's day rolls over, and which day an hour worked belongs to. Without it we have to assume UTC, which is right for almost nobody.",
          opens: "settings-business",
          done: async (orgId) => {
            const [org] = await db
              .select({ timezone: schema.organizations.timezone })
              .from(schema.organizations)
              .where(eq(schema.organizations.id, orgId))
              .limit(1);
            /*
             * Known, not merely present. A typo saved as "Americas/Denver" is a
             * field somebody has filled in and a timezone nothing can read, and
             * `timezoneFor` falls back to UTC on exactly that — so the step has
             * to agree with the code that uses it or it would read as done
             * while the business ran on the fallback.
             */
            return Boolean(org?.timezone && knownTimezone(org.timezone));
          },
        },
        /*
         * And which country it trades in, because that is also the currency.
         *
         * `baseCurrency` is `notNull` and defaults to USD, and the first journal
         * entry locks it — so a business in Toronto that never opens this screen
         * keeps its books in dollars for ever, and the only thing that ever says
         * so is the refusal it gets if it tries to change them later. Three of
         * the four markets this is sold into, decided by a column default.
         *
         * The screen itself handles it well: choosing a country fills the
         * currency in while the ledger is still empty, with both fields in view.
         * Nothing sent anybody to the screen. A checklist step is the mechanism
         * that exists for a setting whose cost is invisible — the timezone above
         * is here for the same reason — and this one's window closes, which the
         * timezone's does not.
         */
        {
          id: "country",
          label: "Say where your business trades, and in what",
          detail:
            "Your country sets how money is written on everything you send, and fills in the currency your books are kept in. That currency is fixed as soon as anything is posted to the ledger, so it is worth a minute now: changing it afterwards would mean restating every figure in the books at rates nobody recorded.",
          opens: "settings-business",
          done: async (orgId) => {
            const [org] = await db
              .select({
                countryCode: schema.organizations.countryCode,
                baseCurrency: schema.organizations.baseCurrency,
              })
              .from(schema.organizations)
              .where(eq(schema.organizations.id, orgId))
              .limit(1);
            const country = (org?.countryCode ?? "").trim().toUpperCase();
            if (!country) return false;
            /*
             * Dollar books outside the United States is the one shape worth
             * nagging about, and it is the shape the default produces. Any other
             * combination is a choice somebody could have made on purpose —
             * including euro books in Delaware — and a step that second-guesses
             * those would never clear.
             *
             * Asked only in that case, so the ordinary instance pays one query
             * for this step rather than two. And once the ledger has entries the
             * field is disabled, so the step would be sending somebody to a
             * control they cannot use: done, and the screen explains why.
             */
            if (org?.baseCurrency === "USD" && country !== "US") {
              return await baseCurrencyLocked(orgId);
            }
            return true;
          },
        },
      ],
    });

    ctx.registerNav({
      id: "settings",
      icon: "sliders",
      label: "Settings",
      order: 90,
      group: "Configuration",
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
      { id: "settings-license", label: "License and updates", icon: "key" },
      { id: "settings-modules", label: "Modules", icon: "boxes" },
      /*
       * Beside the other settings rather than buried in one: answering a
       * subject access request has a legal deadline, and a screen somebody has
       * to hunt for is a screen they find on day twenty-nine.
       */
      { id: "settings-privacy", label: "Personal data", icon: "shield" },
    ].entries()) {
      ctx.registerNav({
        ...page[1],
        // Beside its parent: `order` sorts the whole nav, not each module.
        order: 90 + (page[0] + 1) / 100,
        parent: "settings",
        group: "Configuration",
        requires: { settings: ["read"] },
      });
    }
    for (const p of ["read", "update"]) {
      ctx.registerPermission(`settings:${p}`);
    }

    registerPaymentAccounts(ctx);
    registerPaymentWebhookEndpoint(ctx);

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
            /*
             * The structured half of the identity: what a machine reads where
             * the free-text address is what a person reads. The e-invoice
             * refuses without the ones it needs, and this is where they get
             * fixed.
             */
            city: org?.city ?? "",
            postcode: org?.postcode ?? "",
            countryCode: org?.countryCode ?? "",
            /*
             * What the books are kept in, and whether that is still open.
             *
             * It defaulted to USD and no screen on any tier but Pro could set
             * it — so every Free instance outside the United States invoiced in
             * dollars, permanently, in three of this product's four markets.
             */
            baseCurrency: org?.baseCurrency ?? "USD",
            baseCurrencyLocked: await baseCurrencyLocked(orgId),
            // The four markets' own, for a screen that should not make anybody
            // type. Any three-letter code is still accepted on the way in.
            currencyChoices: [...MARKET_CURRENCIES],
            email: org?.email ?? "",
            phone: org?.phone ?? "",
            iban: org?.iban ?? "",
            /*
             * Empty means the server's own, which is the honest default rather
             * than guessing. The screen offers to fill it in with the browser's.
             */
            timezone: org?.timezone ?? "",
            /*
             * What a visitor is told about the software underneath, at the
             * foot of every page they land on — the sign-in screen, a form's
             * thank-you. Free always says ours. For Pro the stored text is
             * three-valued and null must survive the round trip: null is
             * untouched (ours shows), empty is removed, anything else is the
             * business's own line.
             */
            creditText: org?.creditText ?? null,
            creditUrl: org?.creditUrl ?? "",
            canSetCredit: ctx.entitled({ tier: "pro" }),
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
              /*
               * One address per processor, not one per module.
               *
               * This used to offer two — an invoice one and a shop one — while
               * the connect screen automatically registered only the shop's.
               * A business that pasted the invoice address got its shop orders
               * dropped, and one that let us set it up got its invoice
               * payments dropped, which is what actually happened.
               */
              webhookUrl: `${base}/api/payments/webhook/stripe`,
            },
            paypal: {
              configured:
                configured("PAYPAL_CLIENT_ID") &&
                configured("PAYPAL_CLIENT_SECRET"),
              webhookConfigured: configured("PAYPAL_WEBHOOK_ID"),
              environment: process.env.PAYPAL_ENV ?? "sandbox",
              webhookUrl: `${base}/api/payments/webhook/paypal`,
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
        // Read outside the try, whose catch calls every failure a disk fault.
        const enabled = asFlag(body.enabled, "enabled", false);
        try {
          await setTelemetryEnabled(enabled);
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
        const key = asTextOrNothing(body.key, "key")?.trim() ?? "";

        if (!isValidLicenseKey(key.toUpperCase())) {
          // Deliberately says nothing about which part is wrong: this is the
          // shape of the key, not whether it is real, and hinting at the
          // difference helps someone guessing at keys.
          return c.json(
            { error: "that does not look like a Sentrello license key" },
            400,
          );
        }

        if (keyIsFromEnvironment()) {
          // A key set on the server is the more privileged of the two and must
          // not be silently replaced from a browser.
          return c.json(
            {
              error:
                "this instance's license key is set on the server. Change it there.",
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
     * What someone presses after buying a module on the website, for the
     * business that does not want to wait even for the hourly refresh —
     * which, since `apps/server/src/module-acquisition.ts`, raises this same
     * request on its own the moment it sees the licence gain something this
     * instance does not have. Either way the bundle still needs the restart
     * this endpoint's status already asks for.
     */
    ctx.app.post(
      "/api/settings/sync",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        if (!(await licenseKey())) {
          return c.json({ error: "this instance has no license key yet" }, 409);
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
              error: "could not reach the license server to check for updates",
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

        const name = asText(body.name, "name").trim();
        if (!name) return c.json({ error: "a name is required" }, 400);
        if (name.length > 120) {
          return c.json({ error: "that name is too long" }, 400);
        }

        // These reach customers on every invoice, so they are bounded rather
        // than trusted: an address is a few lines, not a document.
        // Text or a 400 naming it: `String({})` put "[object Object]" on
        // every invoice as the business's address.
        const text = (value: unknown, limit: number, field: string) => {
          const trimmed = (asTextOrNothing(value, field) ?? "").trim();
          if (trimmed.length > limit) throw new RangeError(field);
          return trimmed || null;
        };

        let address: string | null;
        let taxId: string | null;
        let taxIdLabel: string | null;
        let paymentInstructions: string | null;
        let timezone: string | null;
        let creditText: string | null;
        let creditUrl: string | null;
        let city: string | null;
        let postcode: string | null;
        let countryCode: string | null;
        let email: string | null;
        let phone: string | null;
        let iban: string | null;
        try {
          address = text(body.address, 500, "address");
          taxId = text(body.taxId, 60, "tax number");
          taxIdLabel = text(body.taxIdLabel, 40, "tax number label");
          paymentInstructions = text(
            body.paymentInstructions,
            800,
            "payment instructions",
          );
          timezone = text(body.timezone, 60, "timezone");
          city = text(body.city, 120, "city");
          postcode = text(body.postcode, 20, "postcode");
          countryCode = text(body.countryCode, 2, "country code");
          email = text(body.email, 200, "email");
          phone = text(body.phone, 40, "phone number");
          iban = text(body.iban, 50, "IBAN");
          /*
           * Not the `text()` helper, which reads an empty string as null.
           * For the credit those are two different decisions: null is the
           * setting untouched, so the Sentrello line shows; an empty string
           * is the business removing the line, and collapsing one into the
           * other would bring the branding back on a business that took it
           * off — or take a removal it never made and make it permanent.
           */
          if (body.creditText === null || body.creditText === undefined) {
            creditText = null;
          } else {
            creditText = asText(body.creditText, "creditText").trim();
            if (creditText.length > 60) throw new RangeError("credit");
          }
          creditUrl = text(body.creditUrl, 200, "credit link");
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

        /*
         * Checked against the ones this machine actually knows, rather than
         * stored as typed.
         *
         * A timezone the server cannot resolve does not fail loudly: every
         * calculation quietly falls back to the server's own, so a business
         * that typed "EST" instead of "America/New_York" would see its Monday
         * chases go out at the wrong hour and find nothing anywhere saying why.
         * Refused at the door instead, where somebody is looking at the form
         * they just filled in.
         */
        if (timezone && !knownTimezone(timezone)) {
          return c.json(
            { error: `"${timezone}" is not a timezone this server knows` },
            400,
          );
        }

        /*
         * The country as two letters — "DE", not "Germany" — because the
         * e-invoice standard reads nothing else, and a prose country typed
         * here would surface weeks later as a rejected document.
         */
        if (countryCode) {
          if (!/^[A-Za-z]{2}$/.test(countryCode)) {
            return c.json(
              {
                error: 'the country goes in as two letters — "DE", "GB", "US"',
              },
              400,
            );
          }
          countryCode = countryCode.toUpperCase();
        }

        /*
         * The IBAN routes actual money, so a typo is checked at the door:
         * shape first, then the standard mod-97 checksum every bank applies.
         * Refusing here costs a retype; accepting quietly costs a transfer
         * that bounces weeks after the invoice went out.
         */
        if (iban) {
          iban = iban.replace(/\s+/g, "").toUpperCase();
          const shaped = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban);
          const digits = shaped
            ? (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (ch) =>
                String(ch.charCodeAt(0) - 55),
              )
            : "";
          let remainder = 0;
          for (const digit of digits) {
            remainder = (remainder * 10 + Number(digit)) % 97;
          }
          if (!shaped || remainder !== 1) {
            return c.json(
              { error: "that IBAN does not check out — one character is off" },
              400,
            );
          }
        }

        /*
         * The currency the books are kept in, on the screen that already holds
         * the country and the timezone — the other two facts about where a
         * business is.
         *
         * Written through `setBaseCurrency` rather than here, because
         * Accounting has a route for the same column on Pro and two copies of
         * "may this still change" would disagree the week one of them moved,
         * about what somebody's books mean.
         *
         * Last, after every other field has been checked. It writes, and a save
         * that then refused the country would have changed the currency and told
         * the person nothing was saved.
         */
        if (body.baseCurrency !== undefined) {
          const set = await setBaseCurrency(
            orgId,
            asText(body.baseCurrency, "baseCurrency"),
          );
          if ("error" in set) return c.json({ error: set.error }, set.status);
        }

        const [org] = await db
          .update(schema.organizations)
          .set({
            name,
            address,
            taxId,
            taxIdLabel,
            paymentInstructions,
            timezone,
            city,
            postcode,
            countryCode,
            email,
            phone,
            iban,
            /*
             * Ignored unless this instance is Pro. The credit on a Free
             * instance is not the business's to change — it is part of what
             * Free is — and a field that silently did nothing would be a
             * setting somebody sets and then wonders about.
             */
            ...(ctx.entitled({ tier: "pro" }) ? { creditText, creditUrl } : {}),
          })
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
            city: org?.city ?? "",
            postcode: org?.postcode ?? "",
            countryCode: org?.countryCode ?? "",
            email: org?.email ?? "",
            phone: org?.phone ?? "",
            iban: org?.iban ?? "",
            timezone: org?.timezone ?? "",
            creditText: org?.creditText ?? null,
            creditUrl: org?.creditUrl ?? "",
            canSetCredit: ctx.entitled({ tier: "pro" }),
          },
        });
      },
    );
  },
});

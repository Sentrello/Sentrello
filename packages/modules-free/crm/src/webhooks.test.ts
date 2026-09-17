import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import crm from "./index";
import { RETRY_MINUTES, deliverDue, fanOutDue } from "./webhooks";

// Sealing the endpoint secret needs an instance key, which a bare test
// process does not have.
process.env.SENTRELLO_SECRET_KEY ||= "a-test-instance-key";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-webhooks-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

/** A sender that records what would have left the machine, and answers as told. */
function fakeSender(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status >= 400 ? "no" : "ok", { status });
  };
  return { calls, send };
}

beforeAll(async () => {
  crm.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerWidget: () => {},
    registerAccountSection: () => {},
    registerSearch: () => {},
    registerPersonalData: () => {},
    registerOnboarding: () => {},
    registerCrawlable: () => {},
    provide: () => {},
    registerJob: () => {},
  });

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Hooks ${suffix}`, slug: `hooks-${suffix}` },
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
  for (const [table, column] of [
    [schema.crmWebhookDeliveries, schema.crmWebhookDeliveries.organizationId],
    [schema.crmWebhooks, schema.crmWebhooks.organizationId],
    [schema.recordEvents, schema.recordEvents.organizationId],
    [schema.securityEvents, schema.securityEvents.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.companies, schema.companies.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
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

test("an endpoint inside our own network is refused at the door", async () => {
  for (const url of [
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/hook",
  ]) {
    const res = await app.request("http://localhost/api/crm/webhooks", {
      method: "POST",
      headers,
      body: JSON.stringify({ url, entities: ["contact"] }),
    });
    expect(res.status).toBe(400);
  }
});

test("plain http is refused unless the business says it knows", async () => {
  const refused = await app.request("http://localhost/api/crm/webhooks", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: "http://93.184.216.34/hook",
      entities: ["contact"],
      allowInsecure: false,
    }),
  });
  expect(refused.status).toBe(400);
});

let webhookId: string;
let secret: string;

test("creating an endpoint returns the secret once and never again", async () => {
  const res = await app.request("http://localhost/api/crm/webhooks", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: "https://93.184.216.34/hook",
      entities: ["contact", "deal"],
      allowInsecure: false,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    webhook: { id: string; secret?: string };
    secret: string;
  };
  expect(body.secret).toStartWith("crmwh_");
  expect(body.webhook.secret).toBeUndefined();
  webhookId = body.webhook.id;
  secret = body.secret;

  const list = await app.request("http://localhost/api/crm/webhooks", {
    headers,
  });
  const listed = (await list.json()) as {
    webhooks: { id: string; secret?: string }[];
  };
  const mine = listed.webhooks.find((w) => w.id === webhookId);
  expect(mine).toBeDefined();
  expect(mine?.secret).toBeUndefined();
});

test("a contact change reaches the endpoint, signed verifiably", async () => {
  const created = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Signed Delivery", email: "sd@example.test" }),
  });
  expect(created.status).toBe(201);
  const { contact } = (await created.json()) as { contact: { id: string } };

  const { calls, send } = fakeSender();
  await fanOutDue();
  const outcome = await deliverDue(new Date(), send);
  expect(outcome.delivered).toBe(1);
  expect(calls).toHaveLength(1);

  const call = calls[0];
  if (!call) throw new Error("nothing was sent");
  expect(call.url).toBe("https://93.184.216.34/hook");

  const sent = JSON.parse(String(call.init.body)) as {
    event: string;
    entityId: string;
    after: Record<string, unknown> | null;
  };
  expect(sent.event).toBe("contact.created");
  expect(sent.entityId).toBe(contact.id);
  // The portal token is a credential, not a fact about the contact.
  expect(sent.after?.portalToken).toBeUndefined();

  const headerValue = new Headers(call.init.headers).get(
    "x-sentrello-signature",
  );
  expect(headerValue).toBeTruthy();
  const [t, v1] = String(headerValue).split(",");
  const timestamp = String(t).slice(2);
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${String(call.init.body)}`)
    .digest("hex");
  expect(v1).toBe(`v1=${mac}`);
});

test("an entity the endpoint did not ask about is not delivered", async () => {
  const created = await app.request("http://localhost/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Quiet Company" }),
  });
  expect(created.status).toBe(201);

  const { calls, send } = fakeSender();
  await fanOutDue();
  await deliverDue(new Date(), send);
  expect(calls).toHaveLength(0);
});

test("another organization's events never reach this endpoint", async () => {
  await db.insert(schema.recordEvents).values({
    organizationId: `foreign-${suffix}`,
    entity: "contact",
    entityId: crypto.randomUUID(),
    action: "created",
    changed: [],
    after: { name: "Somebody Else's" },
  });

  const { calls, send } = fakeSender();
  await fanOutDue();
  await deliverDue(new Date(), send);
  expect(calls).toHaveLength(0);

  await db
    .delete(schema.recordEvents)
    .where(eq(schema.recordEvents.organizationId, `foreign-${suffix}`));
});

test("a URL that now resolves inside is refused again at send time", async () => {
  // The endpoint was accepted when its name pointed outside; DNS has since
  // been re-pointed at loopback. The judgement at the door cannot see that,
  // which is why it runs again before every send.
  await db
    .update(schema.crmWebhooks)
    .set({ url: "https://127.0.0.1/hook" })
    .where(eq(schema.crmWebhooks.id, webhookId));

  const created = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Rebound", email: "rb@example.test" }),
  });
  expect(created.status).toBe(201);

  const { calls, send } = fakeSender();
  await fanOutDue();
  const outcome = await deliverDue(new Date(), send);
  expect(calls).toHaveLength(0);
  expect(outcome.delivered).toBe(0);
  expect(outcome.retried).toBe(1);

  await db
    .update(schema.crmWebhooks)
    .set({ url: "https://93.184.216.34/hook" })
    .where(eq(schema.crmWebhooks.id, webhookId));
});

test("a failing endpoint is retried on the schedule, then abandoned", async () => {
  const [delivery] = await db
    .select()
    .from(schema.crmWebhookDeliveries)
    .where(eq(schema.crmWebhookDeliveries.status, "pending"))
    .limit(1);
  if (!delivery) throw new Error("the previous test left no pending delivery");

  // Fail every attempt, jumping the clock to each recorded retry time, and
  // check each failure books the next try on the published schedule — 1, 5,
  // 30, 120, 720 minutes — until the schedule runs out and the log says
  // abandoned rather than booking a forever job.
  for (let guard = 0; guard <= RETRY_MINUTES.length + 1; guard++) {
    const [row] = await db
      .select()
      .from(schema.crmWebhookDeliveries)
      .where(eq(schema.crmWebhookDeliveries.id, delivery.id));
    if (!row) throw new Error("the delivery vanished");
    if (row.status !== "pending") break;
    if (guard > RETRY_MINUTES.length) {
      throw new Error("the delivery is being retried for ever");
    }

    const due = row.nextAttemptAt;
    const { send } = fakeSender(500);
    await deliverDue(due, send);

    const [after] = await db
      .select()
      .from(schema.crmWebhookDeliveries)
      .where(eq(schema.crmWebhookDeliveries.id, delivery.id));
    if (!after) throw new Error("the delivery vanished");
    expect(after.attempts).toBe(row.attempts + 1);
    expect(after.lastStatus).toBe(500);
    const minutes = RETRY_MINUTES[after.attempts - 1];
    if (minutes === undefined) {
      expect(after.status).toBe("abandoned");
    } else {
      expect(after.status).toBe("pending");
      expect(after.nextAttemptAt.getTime()).toBe(
        due.getTime() + minutes * 60_000,
      );
    }
  }

  const [abandoned] = await db
    .select()
    .from(schema.crmWebhookDeliveries)
    .where(eq(schema.crmWebhookDeliveries.id, delivery.id));
  expect(abandoned?.status).toBe("abandoned");
  expect(abandoned?.attempts).toBe(RETRY_MINUTES.length + 1);

  const log = await app.request(
    `http://localhost/api/crm/webhooks/${webhookId}/deliveries`,
    { headers },
  );
  expect(log.status).toBe(200);
  const seen = (await log.json()) as {
    deliveries: { id: string; status: string }[];
    counts: { abandoned: number };
  };
  expect(seen.deliveries.some((d) => d.id === delivery.id)).toBe(true);
  expect(seen.counts.abandoned).toBeGreaterThanOrEqual(1);
});

test("deleting the endpoint takes its history with it", async () => {
  const res = await app.request(
    `http://localhost/api/crm/webhooks/${webhookId}`,
    { method: "DELETE", headers },
  );
  expect(res.status).toBe(200);
  const gone = await db
    .select()
    .from(schema.crmWebhookDeliveries)
    .where(eq(schema.crmWebhookDeliveries.webhookId, webhookId));
  expect(gone).toHaveLength(0);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { PersonalDataSource, SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import crm from "./index";
import { fanOutDue } from "./webhooks";

/**
 * Erasing somebody out of the logs that kept a copy of them.
 *
 * Deleting the contact was never the hard part. The hard part is every place
 * the platform wrote the record down in passing — the change feed, the webhook
 * delivery log, the record of what a merge folded in, and, in the paid
 * automations, the run log that keeps the record a workflow was working on.
 * A business that erases somebody and leaves a full copy of them in a run log
 * has not erased them, and the privacy screen saying it has is worse than the
 * gap: it turns a technical shortfall into a false statement to a data subject.
 *
 * What has to survive is the *operational* half. Knowing that a delivery was
 * attempted six times and abandoned, that a run happened, that two contacts
 * were merged on a Tuesday — those are facts about the business, not about the
 * person. So the rows stay, their shape stays, and only the person comes out.
 */

process.env.SENTRELLO_SECRET_KEY ||= "a-test-instance-key";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-erasure-${suffix}@example.test`;
const subjectEmail = `forget-me-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();
const foreignOrg = `foreign-${suffix}`;

let orgId: string;
let headers: Headers;
let source: PersonalDataSource;

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
    registerPersonalData: (registered) => {
      if (registered.id === "crm") source = registered;
    },
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
    body: { name: `Erasure ${suffix}`, slug: `erasure-${suffix}` },
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
    [schema.contactMerges, schema.contactMerges.organizationId],
    [schema.recordEvents, schema.recordEvents.organizationId],
    [schema.securityEvents, schema.securityEvents.organizationId],
    [schema.notes, schema.notes.organizationId],
    [schema.activities, schema.activities.organizationId],
    [schema.contacts, schema.contacts.organizationId],
  ] as const) {
    for (const org of [orgId, foreignOrg]) {
      await db.delete(table).where(eq(column, org));
    }
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

test("erasing somebody empties the logs that kept a copy of them", async () => {
  // A person, and an endpoint that will be told about them.
  const made = await app.request("http://localhost/api/crm/webhooks", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: "https://93.184.216.36/hook",
      entities: ["contact"],
      allowInsecure: false,
    }),
  });
  expect(made.status).toBe(201);

  const created = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Forget Me",
      email: subjectEmail,
      phone: "+1 555 0100",
    }),
  });
  expect(created.status).toBe(201);
  const { contact } = (await created.json()) as { contact: { id: string } };

  // The delivery log: a run log in every sense that matters — what was sent,
  // to whom, how many times it was tried, and the record it carried.
  await fanOutDue();
  const [delivery] = await db
    .select()
    .from(schema.crmWebhookDeliveries)
    .where(eq(schema.crmWebhookDeliveries.organizationId, orgId));
  if (!delivery) throw new Error("nothing was queued for delivery");
  expect(
    (delivery.payload as { after?: { email?: string } }).after?.email,
  ).toBe(subjectEmail);

  // And the record of a merge, which keeps the folded-in person whole.
  await db.insert(schema.contactMerges).values({
    organizationId: orgId,
    keptId: crypto.randomUUID(),
    mergedId: contact.id,
    mergedRecord: { id: contact.id, name: "Forget Me", email: subjectEmail },
    moved: { notes: 2 },
  });

  // The same person's details, in another organization's logs. Nothing an
  // erasure here does may reach them.
  await db.insert(schema.recordEvents).values({
    organizationId: foreignOrg,
    entity: "contact",
    entityId: crypto.randomUUID(),
    action: "created",
    changed: [],
    after: { name: "Somebody Else's", email: subjectEmail },
  });

  const outcome = await source.erase?.(orgId, { email: subjectEmail });
  expect(outcome).toBeDefined();
  // Counted and said out loud, because "we cleared four log entries" and "we
  // found nothing" are different answers and the person is owed the real one.
  expect(outcome?.removed.join(" ")).toContain("log entr");
  // And what stays is stated rather than implied — the half that makes the
  // answer lawful instead of merely reassuring.
  expect(outcome?.kept.map((k) => k.what).join(" ")).toContain("log entry");

  // The contact itself is gone.
  const left = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contact.id));
  expect(left).toHaveLength(0);

  // The feed still says a contact was created, and holds nothing about who.
  const events = await db
    .select()
    .from(schema.recordEvents)
    .where(
      and(
        eq(schema.recordEvents.organizationId, orgId),
        eq(schema.recordEvents.entityId, contact.id),
      ),
    );
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.entity).toBe("contact");
    expect(event.action).toBe("created");
    expect(event.before).toBeNull();
    expect(event.after).toBeNull();
  }

  // The delivery is still a legible attempt: which endpoint, which event, how
  // it went. The record it carried is empty.
  const [afterErase] = await db
    .select()
    .from(schema.crmWebhookDeliveries)
    .where(eq(schema.crmWebhookDeliveries.id, delivery.id));
  if (!afterErase) throw new Error("the delivery log was deleted, not emptied");
  expect(afterErase.event).toBe("contact.created");
  expect(afterErase.status).toBe(delivery.status);
  expect(afterErase.attempts).toBe(delivery.attempts);
  const payload = afterErase.payload as Record<string, unknown>;
  expect(payload.event).toBe("contact.created");
  expect(payload.action).toBe("created");
  expect(payload.before).toBeNull();
  expect(payload.after).toBeNull();

  // The merge still happened; the person it folded in is not there.
  const [merge] = await db
    .select()
    .from(schema.contactMerges)
    .where(eq(schema.contactMerges.organizationId, orgId));
  if (!merge) throw new Error("the merge record was deleted, not emptied");
  expect(merge.mergedId).toBe(contact.id);
  expect(merge.moved).toEqual({ notes: 2 });
  expect(merge.mergedRecord).toEqual({});

  // Nowhere in this organization's logs is the address still written down.
  const trace = await db.execute(
    `select count(*)::int as found from record_events
       where organization_id = '${orgId}'
         and (before::text ilike '%${subjectEmail}%' or after::text ilike '%${subjectEmail}%')`,
  );
  expect((trace[0] as { found: number }).found).toBe(0);

  // And the other organization's copy is untouched, which is the line an
  // erasure must never cross.
  const [foreign] = await db
    .select()
    .from(schema.recordEvents)
    .where(eq(schema.recordEvents.organizationId, foreignOrg));
  expect((foreign?.after as { email?: string } | null)?.email).toBe(
    subjectEmail,
  );
});

/**
 * A week after the business deleted them, they ask to be forgotten.
 *
 * The contact row is long gone, so nothing matches by email any more — and the
 * change feed is now the only copy. It holds the record the delete carried,
 * and, since the delete takes a contact's notes, calls, follow-ups and tag
 * links with it in the same transaction, it holds those too: somebody's
 * correspondence, whole, in a column called `related`.
 *
 * An erasure that emptied `before` and `after` and left that behind would have
 * moved the person rather than removed them, and said on a screen that it was
 * done.
 */
test("a contact deleted last week is still erased out of the feed", async () => {
  const gone = `deleted-then-erased-${suffix}@example.test`;
  const created = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Already Gone", email: gone }),
  });
  expect(created.status).toBe(201);
  const { contact } = (await created.json()) as { contact: { id: string } };

  await app.request("http://localhost/api/notes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      entityType: "contact",
      entityId: contact.id,
      text: "Said he is off work until the ninth",
    }),
  });
  await app.request("http://localhost/api/activities", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "call",
      contactId: contact.id,
      body: "Rang about the invoice",
    }),
  });

  const deleted = await app.request(
    `http://localhost/api/contacts/${contact.id}`,
    { method: "DELETE", headers },
  );
  expect(deleted.status).toBe(200);

  // The feed is carrying them, twice over.
  const [before] = await db
    .select()
    .from(schema.recordEvents)
    .where(
      and(
        eq(schema.recordEvents.organizationId, orgId),
        eq(schema.recordEvents.entityId, contact.id),
        eq(schema.recordEvents.action, "deleted"),
      ),
    );
  expect(JSON.stringify(before?.related)).toContain("off work until the ninth");

  const outcome = await source.erase?.(orgId, { email: gone });
  expect(outcome?.removed.join(" ")).toContain("log entr");

  const events = await db
    .select()
    .from(schema.recordEvents)
    .where(
      and(
        eq(schema.recordEvents.organizationId, orgId),
        eq(schema.recordEvents.entityId, contact.id),
      ),
    );
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    // The fact stays: a contact was created, changed, deleted, and by whom.
    expect(event.entity).toBe("contact");
    expect(event.before).toBeNull();
    expect(event.after).toBeNull();
    expect(event.related).toBeNull();
  }

  const trace = await db.execute(
    `select count(*)::int as found from record_events
       where organization_id = '${orgId}'
         and (before::text ilike '%off work until the ninth%'
              or after::text ilike '%off work until the ninth%'
              or related::text ilike '%off work until the ninth%'
              or related::text ilike '%${gone}%')`,
  );
  expect((trace[0] as { found: number }).found).toBe(0);
});

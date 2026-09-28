import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { contactHasEmail } from "@sentrello/db/crm";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  addressOf,
  addressesOf,
  candidateAddresses,
  htmlToText,
  parseInbound,
  secretMatches,
} from "./inbound";
import crm from "./index";

/**
 * The endpoint behind these functions is unauthenticated by necessity — a mail
 * provider posts to it. What is tested here is everything that stands in for a
 * session: the secret comparison, which address the message is filed against,
 * and what happens when it matches nobody.
 */

test("a secret is compared whole, and only when there is one", () => {
  expect(secretMatches("abc123", "abc123")).toBe(true);
  expect(secretMatches("abc124", "abc123")).toBe(false);
  // Capture is off until somebody turns it on, and off means nothing matches.
  expect(secretMatches("", null)).toBe(false);
  expect(secretMatches("anything", null)).toBe(false);
  // A prefix is not a match, and a different length must not throw.
  expect(secretMatches("abc", "abc123")).toBe(false);
  expect(secretMatches("abc123456", "abc123")).toBe(false);
});

test("an address is pulled out of whatever the header looked like", () => {
  expect(addressOf("Dave Nunn <Dave@Example.com>")).toBe("dave@example.com");
  expect(addressOf("  dave@example.com ")).toBe("dave@example.com");
  expect(addressOf("not an address")).toBeNull();
  expect(addressOf("dave@localhost")).toBeNull();
  expect(addressOf(undefined)).toBeNull();
});

test("a header with several addresses gives all of them", () => {
  expect(addressesOf("a@x.com, Bee <b@y.com>, rubbish")).toEqual([
    "a@x.com",
    "b@y.com",
  ]);
  // Postmark sends objects rather than a string.
  expect(addressesOf([{ Email: "c@z.com" }, { email: "d@z.com" }])).toEqual([
    "c@z.com",
    "d@z.com",
  ]);
});

test("a message is read whichever provider posted it", () => {
  const postmark = parseInbound({
    From: "Dave Nunn <dave@example.com>",
    To: "sales@ours.test",
    Cc: "capture@ours.test",
    Subject: "Re: the quote",
    TextBody: "Looks fine, go ahead.",
  });
  expect(postmark.from).toBe("dave@example.com");
  expect(postmark.recipients).toEqual(["sales@ours.test", "capture@ours.test"]);
  expect(postmark.subject).toBe("Re: the quote");
  expect(postmark.body).toBe("Looks fine, go ahead.");

  const mailgun = parseInbound({
    from: "dave@example.com",
    to: "capture@ours.test",
    subject: "Hello",
    "body-plain": "Morning.",
  });
  expect(mailgun.body).toBe("Morning.");
});

test("a message with only HTML still reads as a sentence", () => {
  const message = parseInbound({
    from: "dave@example.com",
    subject: "Quote",
    HtmlBody:
      "<style>p{color:red}</style><p>Morning,</p><p>The <b>price</b> is fine.</p>",
  });
  expect(message.body).toBe("Morning,\nThe price is fine.");
  expect(message.body).not.toContain("color:red");
});

test("the business's own capture address is never the customer", () => {
  // The business CCs itself on mail it sends. Filing that against itself would
  // file every outgoing conversation against nobody.
  const message = parseInbound({
    From: "us@ours.test",
    To: "dave@example.com",
    Cc: "capture@ours.test",
    Subject: "Your quote",
    TextBody: "Attached.",
  });
  expect(candidateAddresses(message, "capture@ours.test")).toEqual([
    "us@ours.test",
    "dave@example.com",
  ]);
  expect(candidateAddresses(message, "CAPTURE@ours.test")).not.toContain(
    "capture@ours.test",
  );
});

test("an attachment with no content is not an attachment", () => {
  const message = parseInbound({
    from: "dave@example.com",
    subject: "Photos",
    Attachments: [
      { Name: "damp.jpg", ContentType: "image/jpeg", Content: "AAAA" },
      { Name: "empty.pdf", ContentType: "application/pdf", Content: "" },
    ],
  });
  expect(message.attachments).toHaveLength(1);
  expect(message.attachments[0]?.name).toBe("damp.jpg");
});

test("a body longer than the cap is cut rather than stored whole", () => {
  const message = parseInbound({
    from: "dave@example.com",
    text: "x".repeat(400_000),
  });
  expect(message.body.length).toBe(256 * 1024);
});

test("markup in a body is text, and stays text", () => {
  // Notes are rendered as text, never as HTML, but the stored string should
  // not carry markup either — it ends up in an export, an email, a PDF.
  expect(htmlToText("<p>Hi <script>alert(1)</script>there</p>")).toBe(
    "Hi there",
  );
});

/**
 * And the endpoint itself, because the part that went wrong was a query.
 *
 * Matching read the primary address column and nothing else, so mail to any
 * other address a contact is known by matched nobody — and a miss and a
 * message from a stranger came back as the same word, which is why nothing in
 * the product ever said it was happening. Merging made it reachable: the
 * merged-away address becomes a secondary, so a thread that was on the record
 * yesterday was silently absent today.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `crm-inbound-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let secret: string;

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
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Inbound ${suffix}`, slug: `inbound-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  secret = crypto.randomUUID().replace(/-/g, "");
  await db.insert(schema.crmSettings).values({
    organizationId: orgId,
    inboundSecret: secret,
    inboundAddress: `capture-${suffix}@ours.test`,
  });
});

afterAll(async () => {
  for (const [table, column] of [
    [schema.notes, schema.notes.organizationId],
    [schema.contactMerges, schema.contactMerges.organizationId],
    [schema.recordEvents, schema.recordEvents.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.crmSettings, schema.crmSettings.organizationId],
    [schema.member, schema.member.organizationId],
    [schema.organizationRole, schema.organizationRole.organizationId],
    [schema.userGroupMembers, schema.userGroupMembers.organizationId],
    [schema.userGroups, schema.userGroups.organizationId],
    [schema.securityEvents, schema.securityEvents.organizationId],
    [schema.securityPolicy, schema.securityPolicy.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [owner] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, ownerEmail));
  if (owner) {
    await db.delete(schema.session).where(eq(schema.session.userId, owner.id));
    await db.delete(schema.account).where(eq(schema.account.userId, owner.id));
    await db.delete(schema.user).where(eq(schema.user.id, owner.id));
  }
});

/** One message through the provider's webhook. */
const deliver = async (payload: Record<string, unknown>) => {
  const res = await app.request(
    `http://localhost/api/crm/inbound-email/${orgId}/${secret}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    matched: boolean;
    reason?: string;
    noteId?: string;
  };
};

const notesOn = async (contactId: string) =>
  db
    .select()
    .from(schema.notes)
    .where(
      and(
        eq(schema.notes.organizationId, orgId),
        eq(schema.notes.entityId, contactId),
      ),
    );

test("mail to an address beside the primary one is still that person's", async () => {
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Dana Okafor",
      email: `dana-${suffix}@home.test`,
      emails: [{ label: "work", value: `Dana.Okafor-${suffix}@Firm.test` }],
    })
    .returning();
  if (!contact) throw new Error("could not create the contact");

  const answer = await deliver({
    From: `Dana Okafor <dana.okafor-${suffix}@firm.test>`,
    To: `capture-${suffix}@ours.test`,
    Subject: "About the roof",
    TextBody: "Thursday works.",
  });
  expect(answer.matched).toBe(true);

  const filed = await notesOn(contact.id);
  expect(filed).toHaveLength(1);
  expect(filed[0]?.text).toContain("About the roof");
});

/**
 * Two different nothings, and they have to read differently.
 *
 * A message with nobody to file it against is the correct outcome for mail
 * from a stranger and a defect for mail to a customer's second address — and
 * while both came back as the same bare `matched: false`, the defect was
 * indistinguishable from the product working.
 */
test("nothing to match on reads differently from nobody to match", async () => {
  const stranger = await deliver({
    From: `nobody-${suffix}@elsewhere.test`,
    To: `capture-${suffix}@ours.test`,
    Subject: "Cold approach",
    TextBody: "Interested in your SEO?",
  });
  expect(stranger.matched).toBe(false);
  expect(stranger.reason).toBe("no contact at that address");

  const headerless = await deliver({
    From: "not an address",
    Subject: "Broken",
    TextBody: "No usable header on this at all.",
  });
  expect(headerless.matched).toBe(false);
  expect(headerless.reason).toBe("no address to match on");
  expect(headerless.reason).not.toBe(stranger.reason);
});

/**
 * Merging is what makes the defect reachable in an ordinary week.
 *
 * The address of the contact folded in becomes a labelled extra on the one
 * kept, so a correspondence that was on the record yesterday is filed under an
 * address the matching no longer looked at.
 */
test("a thread survives the contact it belongs to being merged into another", async () => {
  const make = async (name: string, email: string) => {
    const [row] = await db
      .insert(schema.contacts)
      .values({ organizationId: orgId, name, email })
      .returning();
    if (!row) throw new Error("could not create the contact");
    return row;
  };
  const kept = await make("Priya Raman", `priya-${suffix}@firm.test`);
  const folded = await make("P Raman", `p.raman-${suffix}@firm.test`);

  const before = await deliver({
    From: `p.raman-${suffix}@firm.test`,
    To: `capture-${suffix}@ours.test`,
    Subject: "Before the merge",
    TextBody: "First message.",
  });
  expect(before.matched).toBe(true);
  expect(await notesOn(folded.id)).toHaveLength(1);

  const merged = await app.request(
    `http://localhost/api/contacts/${kept.id}/merge`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ mergedId: folded.id }),
    },
  );
  expect(merged.status).toBe(200);

  const after = await deliver({
    From: `p.raman-${suffix}@firm.test`,
    To: `capture-${suffix}@ours.test`,
    Subject: "After the merge",
    TextBody: "Second message.",
  });
  expect(after.matched).toBe(true);

  // Both messages on the surviving record, which is what the thread is.
  const thread = await notesOn(kept.id);
  expect(thread.map((n) => n.text).join(" ")).toContain("Before the merge");
  expect(thread.map((n) => n.text).join(" ")).toContain("After the merge");
});

/**
 * The third place that answered "whose email is this?", and answered it a
 * third way: exactly, on the primary column, so a difference of case made a
 * second contact beside the first.
 */
test("a form enquiry finds the contact whatever address or case it came from", async () => {
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Sam Beal",
      email: `sam-${suffix}@beal.test`,
      emails: [{ label: "work", value: `sam-${suffix}@beal-group.test` }],
    })
    .returning();
  if (!contact) throw new Error("could not create the contact");

  const found = async (email: string) => {
    const [row] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(eq(schema.contacts.organizationId, orgId), contactHasEmail(email)),
      )
      .limit(1);
    return row?.id;
  };

  expect(await found(`SAM-${suffix}@Beal.test`)).toBe(contact.id);
  expect(await found(`sam-${suffix}@beal-group.test`)).toBe(contact.id);
  expect(await found(`somebody-else-${suffix}@beal.test`)).toBeUndefined();
});

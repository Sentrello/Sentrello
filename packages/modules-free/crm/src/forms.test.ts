import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, desc, eq, inArray, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { HONEYPOT_FIELD, resetRateLimits } from "@sentrello/module-sdk";
import { MAX_SUBMISSION_BYTES, splitName } from "./forms";
import crm from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `forms-${suffix}@example.test`;
// Forms is part of the CRM now, so its tests run against the CRM module —
// which is also the honest test of the fold-in: if the routes did not come
// across, every one of these fails.
const app = registerForTest(crm);

let orgId: string;
let headers: Headers;
let contactFormKey: string;
let quoteFormKey: string;

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
    body: { name: `Forms ${suffix}`, slug: `forms-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  for (const [kind, target] of [
    ["contact", "contact"],
    ["quote", "quote"],
  ] as const) {
    const res = await app.request("http://localhost/api/forms", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `${target} form`,
        kind,
        allowedOrigins: ["https://acme.com", "*.shop.acme.com"],
      }),
    });
    const { form } = (await res.json()) as { form: { key: string } };
    if (kind === "contact") contactFormKey = form.key;
    else quoteFormKey = form.key;
  }
});

afterAll(async () => {
  const formIds = (
    await db
      .select({ id: schema.forms.id })
      .from(schema.forms)
      .where(eq(schema.forms.organizationId, orgId))
  ).map((f) => f.id);
  if (formIds.length > 0) {
    await db
      .delete(schema.formSubmissions)
      .where(inArray(schema.formSubmissions.formId, formIds));
  }
  for (const [table, column] of [
    [schema.forms, schema.forms.organizationId],
    [schema.quoteLines, schema.quoteLines.quoteId], // cleaned via quotes below
  ] as const) {
    if (column === schema.quoteLines.quoteId) continue;
    await db.delete(table).where(eq(column, orgId));
  }
  const quoteIds = (
    await db
      .select({ id: schema.quotes.id })
      .from(schema.quotes)
      .where(eq(schema.quotes.organizationId, orgId))
  ).map((q) => q.id);
  if (quoteIds.length > 0) {
    await db
      .delete(schema.quoteLines)
      .where(inArray(schema.quoteLines.quoteId, quoteIds));
  }
  for (const [table, column] of [
    [schema.quotes, schema.quotes.organizationId],
    [schema.documentCounters, schema.documentCounters.organizationId],
    [schema.activities, schema.activities.organizationId],
    [schema.contacts, schema.contacts.organizationId],
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

function submit(key: string, body: unknown, origin = "https://acme.com") {
  resetRateLimits();
  return app.request(`http://localhost/api/embed/forms/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

test("a submission from an allowed origin creates a lead and a timeline note", async () => {
  const res = await submit(contactFormKey, {
    name: "Dana Pike",
    email: "dana@buyer.example",
    phone: "555-0100",
    message: "Do you cover Boulder?",
  });
  expect(res.status).toBe(201);
  expect(res.headers.get("access-control-allow-origin")).toBe(
    "https://acme.com",
  );

  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "dana@buyer.example"));
  expect(contact?.organizationId).toBe(orgId);
  expect(contact?.kind).toBe("lead");
  expect(contact?.phone).toBe("555-0100");

  const activities = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.contactId, contact?.id ?? ""));
  expect(activities[0]?.body).toContain("Boulder");
});

test("a second enquiry from the same address reuses the contact", async () => {
  await submit(contactFormKey, {
    name: "Dana Pike",
    email: "dana@buyer.example",
    message: "Following up",
  });
  const rows = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "dana@buyer.example"));
  expect(rows).toHaveLength(1);
});

test("an unlisted origin gets a 404 that reveals nothing", async () => {
  const res = await submit(
    contactFormKey,
    { name: "Mallory", email: "m@evil.example" },
    "https://evil.example",
  );
  expect(res.status).toBe(404);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();

  const rows = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "m@evil.example"));
  expect(rows).toHaveLength(0);
});

test("an unknown form key is indistinguishable from a refused origin", async () => {
  const res = await submit("frm_does_not_exist", { name: "X" });
  expect(res.status).toBe(404);
});

test("a wildcard subdomain is accepted", async () => {
  const res = await submit(
    contactFormKey,
    { name: "Sub Domain", email: "sub@buyer.example" },
    "https://eu.shop.acme.com",
  );
  expect(res.status).toBe(201);
});

test("a filled honeypot is accepted silently and writes nothing", async () => {
  const res = await submit(contactFormKey, {
    name: "Spam Bot",
    email: "bot@spam.example",
    [HONEYPOT_FIELD]: "http://buy-pills.example",
  });
  // 202, not an error: telling a bot it was caught only teaches it to adapt
  expect(res.status).toBe(202);

  const rows = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "bot@spam.example"));
  expect(rows).toHaveLength(0);
});

test("a submission with neither name nor email is rejected", async () => {
  const res = await submit(contactFormKey, { message: "..." });
  expect(res.status).toBe(400);
});

test("a burst from one client is rate limited", async () => {
  resetRateLimits();
  const send = () =>
    app.request(`http://localhost/api/embed/forms/${contactFormKey}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://acme.com",
        "x-real-ip": "9.9.9.9",
      },
      body: JSON.stringify({ name: "Flood", email: "flood@buyer.example" }),
    });

  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await send()).status);
  expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
});

test("a plain HTML form post works, so a snippet needs no JavaScript", async () => {
  resetRateLimits();
  const body = new URLSearchParams({
    name: "No Script",
    email: "noscript@buyer.example",
    message: "Sent as a normal form",
  });
  const res = await app.request(
    `http://localhost/api/embed/forms/${contactFormKey}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://acme.com",
      },
      body,
    },
  );
  expect(res.status).toBe(201);
});

test("a quote form drafts a quote for pricing", async () => {
  const res = await submit(quoteFormKey, {
    name: "Quote Seeker",
    email: "quote@buyer.example",
    message: "Fence repair, about 40 feet",
  });
  expect(res.status).toBe(201);

  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.organizationId, orgId));
  expect(quote?.status).toBe("draft");
  expect(quote?.number).toMatch(/^QUO-\d{4}$/);
  expect(quote?.totalCents).toBe(0); // nothing priced yet

  const lines = await db
    .select()
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quote?.id ?? ""));
  expect(lines[0]?.description).toContain("Fence repair");
});

test("the public definition endpoint exposes fields but no internals", async () => {
  const res = await app.request(
    `http://localhost/api/embed/forms/${contactFormKey}`,
    { headers: { origin: "https://acme.com" } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.honeypot).toBe(HONEYPOT_FIELD);
  expect(Array.isArray(body.fields)).toBe(true);
  // never leak which instance or organization this belongs to
  expect(body.organizationId).toBeUndefined();
  expect(body.id).toBeUndefined();
});

test("preflight is answered for an allowed origin and refused otherwise", async () => {
  const ok = await app.request(
    `http://localhost/api/embed/forms/${contactFormKey}`,
    { method: "OPTIONS", headers: { origin: "https://acme.com" } },
  );
  expect(ok.status).toBe(204);
  expect(ok.headers.get("access-control-allow-origin")).toBe(
    "https://acme.com",
  );

  const denied = await app.request(
    `http://localhost/api/embed/forms/${contactFormKey}`,
    { method: "OPTIONS", headers: { origin: "https://evil.example" } },
  );
  expect(denied.status).toBe(403);
});

test("submissions are visible to the owner, scoped to their organization", async () => {
  const formId = (
    await db
      .select({ id: schema.forms.id })
      .from(schema.forms)
      .where(eq(schema.forms.key, contactFormKey))
  )[0]?.id;

  const res = await app.request(
    `http://localhost/api/forms/${formId}/submissions`,
    { headers },
  );
  const body = (await res.json()) as { submissions: unknown[] };
  expect(body.submissions.length).toBeGreaterThan(0);
});

/**
 * The snippet this module hands a business is deliberately plain HTML that
 * needs no JavaScript, so most people who use it submit by ordinary form
 * navigation. They used to land on raw JSON — and a business that had set a
 * redirect got it back as a field in that JSON rather than as a redirect, so
 * the setting did nothing for exactly the visitors the snippet was built for.
 */
function submitFromBrowser(
  key: string,
  fields: Record<string, string>,
  origin = "https://acme.com",
) {
  resetRateLimits();
  return app.request(`http://localhost/api/embed/forms/${key}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      origin,
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

test("a browser posting the snippet gets a page, not JSON", async () => {
  const res = await submitFromBrowser(contactFormKey, {
    name: "Ines Bergstrom",
    email: "ines@buyer.example",
    message: "Burst pipe under the sink",
  });

  expect(res.status).toBe(201);
  expect(res.headers.get("content-type")).toContain("text/html");

  const page = await res.text();
  expect(page).toContain("Thanks");
  expect(page).not.toContain('{"ok"');
  // The business's own name, not the product's.
  expect(page).toContain(`Forms ${suffix}`);
});

test("a script posting the same form still gets JSON", async () => {
  const res = await submit(contactFormKey, {
    name: "Script Caller",
    email: "api@buyer.example",
  });
  expect(res.headers.get("content-type")).toContain("application/json");
  expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
});

test("a configured redirect actually redirects the visitor", async () => {
  const [form] = await db
    .select({ id: schema.forms.id })
    .from(schema.forms)
    .where(eq(schema.forms.key, contactFormKey));
  if (!form) throw new Error("expected the contact form");

  await db
    .update(schema.forms)
    .set({ redirectUrl: "https://acme.com/thanks" })
    .where(eq(schema.forms.id, form.id));

  const res = await submitFromBrowser(contactFormKey, {
    name: "Redirected Sender",
    email: "redirected@buyer.example",
  });

  // 303, so a refresh on the destination cannot post the message twice.
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("https://acme.com/thanks");

  await db
    .update(schema.forms)
    .set({ redirectUrl: null })
    .where(eq(schema.forms.id, form.id));
});

test("a browser told what to fix, rather than shown a status code", async () => {
  const res = await submitFromBrowser(contactFormKey, { message: "hello" });
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("name or an email address");
});

test("a bot filling the honeypot sees what a person sees", async () => {
  const before = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));

  const res = await submitFromBrowser(contactFormKey, {
    name: "Cheap Meds",
    email: "spam@buyer.example",
    [HONEYPOT_FIELD]: "http://spam.example",
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Thanks");

  const after = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});

/**
 * Editing the allow-list is the only thing standing between a form and the
 * site it was made for: an embed lives on somebody else's page, so a saved
 * origin has to reach the public endpoints on the very next request.
 */
test("a site added to the allow-list can immediately load and post the form", async () => {
  const created = await app.request("http://localhost/api/forms", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Allow-list form", kind: "contact" }),
  });
  const { form } = (await created.json()) as {
    form: { id: string; key: string };
  };

  // Nowhere yet, so the site it is destined for is refused.
  const before = await app.request(
    `http://localhost/api/embed/forms/${form.key}`,
    { headers: { origin: "https://newsite.example" } },
  );
  expect(before.status).toBe(404);

  const saved = await app.request(`http://localhost/api/forms/${form.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ allowedOrigins: ["https://newsite.example"] }),
  });
  expect(saved.status).toBe(200);
  const updated = (await saved.json()) as {
    form: { allowedOrigins: string[] };
  };
  expect(updated.form.allowedOrigins).toEqual(["newsite.example"]);

  const after = await app.request(
    `http://localhost/api/embed/forms/${form.key}`,
    { headers: { origin: "https://newsite.example" } },
  );
  expect(after.status).toBe(200);
  expect(after.headers.get("access-control-allow-origin")).toBe(
    "https://newsite.example",
  );
});

/**
 * What people type is not what the check compares, so the two have to be
 * reconciled somewhere. Here, loudly: a stored line that can never match is a
 * form that refuses the site it was made for and says nothing about it.
 */
test("sites are stored as hosts, and a typo is refused rather than saved", async () => {
  const created = await app.request("http://localhost/api/forms", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Tidy sites", kind: "contact" }),
  });
  const { form } = (await created.json()) as { form: { id: string } };

  const saved = await app.request(`http://localhost/api/forms/${form.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      allowedOrigins: [
        "  HTTPS://Example.com/contact-us  ",
        "*.Example.com",
        "example.com",
        "",
      ],
    }),
  });
  const body = (await saved.json()) as { form: { allowedOrigins: string[] } };
  expect(body.form.allowedOrigins).toEqual(["example.com", "*.example.com"]);

  const bad = await app.request(`http://localhost/api/forms/${form.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ allowedOrigins: ["not a site"] }),
  });
  expect(bad.status).toBe(400);

  // And the refusal left the working list alone.
  const list = await app.request("http://localhost/api/forms", { headers });
  const forms = (await list.json()) as {
    forms: { id: string; allowedOrigins: string[] }[];
  };
  expect(forms.forms.find((f) => f.id === form.id)?.allowedOrigins).toEqual([
    "example.com",
    "*.example.com",
  ]);
});

/**
 * A form's key is a public credential — it is posted to from a stranger's
 * browser — so the management side has to be certain that holding a session
 * for one business shows nothing belonging to another.
 */
test("another organization's forms and submissions are invisible", async () => {
  const theirs = `other-org-${crypto.randomUUID().slice(0, 8)}`;

  const [form] = await db
    .insert(schema.forms)
    .values({
      organizationId: theirs,
      key: `frm_theirs_${suffix}`,
      name: "Their Secret Enquiry Form",
      kind: "contact",
      fields: [],
      allowedOrigins: [],
    })
    .returning();

  await db.insert(schema.formSubmissions).values({
    organizationId: theirs,
    formId: form?.id as string,
    payload: { name: "Their Private Lead" },
  });

  const list = await app.request("http://localhost/api/forms", { headers });
  const body = await list.text();
  expect(body).not.toContain("Their Secret Enquiry Form");

  // Nor by asking for their form's submissions directly.
  const direct = await app.request(
    `http://localhost/api/forms/${form?.id}/submissions`,
    { headers },
  );
  expect(await direct.text()).not.toContain("Their Private Lead");

  await db
    .delete(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, theirs));
  await db.delete(schema.forms).where(eq(schema.forms.organizationId, theirs));
});

/**
 * A submission becoming a deal.
 *
 * The contact happens on the way in; deciding the enquiry is worth pursuing is
 * a judgement, so it is a button. A pipeline that fills itself with every
 * newsletter sign-up stops being looked at.
 */
test("a submission can be promoted into the pipeline, once", async () => {
  const formId = (
    await db
      .select({ id: schema.forms.id })
      .from(schema.forms)
      .where(eq(schema.forms.key, contactFormKey))
  )[0]?.id;

  const list = (await (
    await app.request(`http://localhost/api/forms/${formId}/submissions`, {
      headers,
    })
  ).json()) as { submissions: { id: string }[] };
  const submissionId = list.submissions[0]?.id;
  expect(submissionId).toBeTruthy();

  const first = await app.request(
    `http://localhost/api/forms/submissions/${submissionId}/promote`,
    { method: "POST", headers },
  );
  expect(first.status).toBe(201);
  const { deal } = (await first.json()) as {
    deal: { id: string; stage: string; contactIds: string[] };
  };
  expect(deal.stage).toBe("opportunity");
  expect(deal.contactIds).toHaveLength(1);

  // Clicking twice must not make a second identical card in the same column.
  const again = await app.request(
    `http://localhost/api/forms/submissions/${submissionId}/promote`,
    { method: "POST", headers },
  );
  const second = (await again.json()) as {
    deal: { id: string };
    already?: boolean;
  };
  expect(second.already).toBe(true);
  expect(second.deal.id).toBe(deal.id);
});

/**
 * The forms a business would otherwise have to invent. A new instance opens
 * this screen to nothing and has to guess what a form is for.
 */
test("the standard forms can be created, and not twice", async () => {
  const first = await app.request("http://localhost/api/forms/defaults", {
    method: "POST",
    headers,
  });
  expect(first.status).toBe(200);
  const { created } = (await first.json()) as { created: string[] };
  expect(created).toContain("Contact us");
  expect(created).toContain("Request a quote");

  // Pressing it again must not double them up — the empty state is gone by
  // then, but the endpoint is still reachable.
  const again = await app.request("http://localhost/api/forms/defaults", {
    method: "POST",
    headers,
  });
  const second = (await again.json()) as { created: string[] };
  expect(second.created).toEqual([]);
});

/**
 * A lead from the website should look like every other contact.
 *
 * The form asks for a name in one box — asking a stranger for two is a box
 * more than they will fill in — but the CRM edits first and last separately.
 * A lead used to arrive with both blank, so the list showed a name and the
 * record showed none.
 */
test("a submitted name reaches the fields the CRM actually edits", () => {
  expect(splitName("Ola Ferreira")).toEqual({
    firstName: "Ola",
    lastName: "Ferreira",
  });
  expect(splitName("Marguerite van der Berg")).toEqual({
    firstName: "Marguerite",
    lastName: "van der Berg",
  });
  // One word stays a first name. Plenty of people have one, and forcing it
  // into a surname records something nobody gave.
  expect(splitName("Prince")).toEqual({ firstName: "Prince", lastName: null });
  expect(splitName("   ")).toEqual({ firstName: null, lastName: null });
  expect(splitName("  Ade   Balogun  ")).toEqual({
    firstName: "Ade",
    lastName: "Balogun",
  });
});

/**
 * A form that is taken down, and the contacts that survive it.
 *
 * The submissions go with the form — they are answers to questions that no
 * longer exist — but anybody who was promoted to a contact stays in the CRM,
 * which is the part a business would actually miss.
 */
test("deleting a form takes its submissions and leaves the contacts", async () => {
  const made = await app.request("http://localhost/api/forms", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Landing page",
      kind: "contact",
      allowedOrigins: ["https://acme.com"],
    }),
  });
  expect(made.status).toBeLessThan(300);
  const { form } = (await made.json()) as { form: { id: string; key: string } };

  await submit(form.key, {
    name: "Marta Villalobos",
    email: "marta@buyer.example",
  });

  const before = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.formId, form.id));
  expect(before.length).toBe(1);

  // The list says how many came in, which is the only thing that tells
  // somebody whether the embed on their website is working at all.
  const listed = await app.request("http://localhost/api/forms", { headers });
  const { forms } = (await listed.json()) as {
    forms: { id: string; submissionCount: number }[];
  };
  expect(forms.find((f) => f.id === form.id)?.submissionCount).toBe(1);

  const gone = await app.request(`http://localhost/api/forms/${form.id}`, {
    method: "DELETE",
    headers,
  });
  expect(gone.status).toBe(200);

  expect(
    await db
      .select()
      .from(schema.formSubmissions)
      .where(eq(schema.formSubmissions.formId, form.id)),
  ).toHaveLength(0);

  // The person is still in the book.
  const [contact] = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, orgId),
        eq(schema.contacts.email, "marta@buyer.example"),
      ),
    );
  expect(contact).toBeDefined();
});

test("submissions export as a spreadsheet, with the form's own columns", async () => {
  // The columns come from the form's field list rather than from the first
  // row's keys. This form asks two questions and only the second submission
  // answers both, which is exactly the case that breaks a header derived from
  // row one: the missing column would vanish, or every later value would slide
  // one place left.
  const made = await app.request("http://localhost/api/forms", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Enquiry, urgent",
      fields: [
        { name: "name", label: "Name", type: "text" },
        {
          name: "branch",
          label: "Which branch?",
          type: "select",
          options: ["North", "South"],
        },
        { name: "when", label: "When", type: "date" },
      ],
    }),
  });
  expect(made.status).toBe(201);
  const { form } = (await made.json()) as { form: { id: string; key: string } };

  for (const payload of [
    { name: "Ada" },
    // A comma and a quote, because a CSV that joins on commas is silently
    // wrong from the row that contains one.
    {
      name: 'Smith, "Jones" & Co',
      branch: "North",
      when: "2026-09-10",
      extra: "kept",
    },
  ]) {
    const sent = await app.request(
      `http://localhost/api/embed/forms/${form.key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    expect(sent.status).toBeLessThan(400);
  }

  const res = await app.request(
    `http://localhost/api/forms/${form.id}/submissions.csv`,
    { headers },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/csv");
  // Named from the form, punctuation and all, so a folder of exports is
  // readable rather than three files called submissions.csv.
  expect(res.headers.get("content-disposition")).toContain(
    "enquiry-urgent.csv",
  );

  const csv = await res.text();
  const [header, ...body] = csv.trim().split("\r\n");
  expect(header).toBe("Received,Name,Which branch?,When,extra");
  expect(body).toHaveLength(2);
  // The first submission answered one of three, so the rest are empty rather
  // than absent — the row still has to line up with the header.
  expect(body[0]).toContain(",Ada,,,");
  // Quoted and doubled, or the file is wrong from here down.
  expect(body[1]).toContain('"Smith, ""Jones"" & Co"');
  // A field the form no longer asks still has answers, and they survive.
  expect(body[1]).toContain("kept");
});

/**
 * Somebody is told when a form is filled in.
 *
 * `notifyEmail` was stored on a form from the day forms existed and read by
 * nothing, so the answer to "who gets told" was nobody, and a business only
 * saw an enquiry if it thought to go and look. Adding the field to the screen
 * without this would have been worse than the gap: a setting that appears to
 * work and does nothing.
 */
test("filling in a form tells whoever the form says to tell", async () => {
  const [form] = await db
    .insert(schema.forms)
    .values({
      organizationId: orgId,
      key: `notify-${suffix}`,
      name: "Notified form",
      kind: "contact",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "email", label: "Email", type: "email", required: true },
      ],
      allowedOrigins: ["https://acme.com"],
      notifyEmail: "enquiries@acme.test",
    })
    .returning();
  if (!form) throw new Error("no form");

  // The adapter picks Resend when the key is set, and Resend is one fetch —
  // so the mail is caught here rather than sent.
  const sent: { to?: string; subject?: string; html?: string }[] = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).includes("api.resend.com")) {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("{}", { status: 200 });
    }
    return realFetch(url as string, init);
  }) as typeof fetch;

  try {
    const res = await submit(form.key, {
      name: "Dana Pike",
      // A field somebody typed, carrying markup: it must arrive escaped.
      email: "dana@buyer.example",
      message: "<script>alert(1)</script> please call me",
    });
    expect(res.status).toBe(201);
  } finally {
    globalThis.fetch = realFetch;
    process.env.RESEND_API_KEY = undefined;
  }

  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("enquiries@acme.test");
  expect(sent[0]?.subject).toContain("Notified form");
  expect(sent[0]?.html).toContain("Dana Pike");
  // Escaped, not executable: this arrives in somebody's inbox.
  expect(sent[0]?.html).toContain("&lt;script&gt;");
  expect(sent[0]?.html).not.toContain("<script>");
});

test("a form with nobody to tell sends nothing", async () => {
  const sent: unknown[] = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).includes("api.resend.com")) {
      sent.push(init);
      return new Response("{}", { status: 200 });
    }
    return realFetch(url as string, init);
  }) as typeof fetch;

  try {
    const res = await submit(contactFormKey, {
      name: "Nobody Waiting",
      email: "quiet@buyer.example",
    });
    expect(res.status).toBe(201);
  } finally {
    globalThis.fetch = realFetch;
    process.env.RESEND_API_KEY = undefined;
  }

  expect(sent).toEqual([]);
});

/**
 * And a mail server that is down does not lose the enquiry.
 *
 * The submission and the timeline note are committed before this runs, and
 * the visitor has already been told it went through — failing their request
 * now would be a lie in the other direction.
 */
test("a refusing mail server still leaves the submission", async () => {
  const [form] = await db
    .insert(schema.forms)
    .values({
      organizationId: orgId,
      key: `broken-${suffix}`,
      name: "Broken mail form",
      kind: "contact",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
      allowedOrigins: ["https://acme.com"],
      notifyEmail: "enquiries@acme.test",
    })
    .returning();
  if (!form) throw new Error("no form");

  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).includes("api.resend.com")) {
      return new Response("no", { status: 500 });
    }
    return realFetch(url as string, init);
  }) as typeof fetch;

  try {
    const res = await submit(form.key, { name: "Still Recorded" });
    expect(res.status).toBe(201);
  } finally {
    globalThis.fetch = realFetch;
    process.env.RESEND_API_KEY = undefined;
  }

  const rows = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.formId, form.id));
  expect(rows).toHaveLength(1);
});

/**
 * The public form is on the internet, and the internet sends what it likes.
 *
 * The rate limit above bounds how *often* a stranger may post. It says nothing
 * about how much they may post at once, and this endpoint read whatever
 * arrived: `req.json()` on an unauthenticated route with no cap. The inbound
 * email endpoint — the only other thing on this product's public surface a
 * stranger may post to — has had a 256KB cap since it was written. This had
 * none.
 *
 * Refused with 413 rather than accepted and truncated, because a message
 * silently cut in half is worse than one the sender is told to shorten: the
 * business would answer a question it could not see the end of.
 */
test("a submission larger than the cap is refused, not read", async () => {
  /*
   * A fixed megabyte, not `MAX_SUBMISSION_BYTES + 1`.
   *
   * Deriving the payload from the constant makes the test agree with whatever
   * the constant says — raise the cap to a gigabyte and it still passes, which
   * is a test of arithmetic rather than of the product. A megabyte through a
   * contact form is wrong at any setting somebody would defend, so the number
   * is written here and the cap has to stay under it.
   */
  const huge = "x".repeat(1024 * 1024);
  const res = await submit(contactFormKey, {
    name: "Too Much",
    email: "toomuch@buyer.example",
    message: huge,
  });
  expect(res.status).toBe(413);
  // And the cap itself stays a form's worth rather than drifting upwards
  // until the assertion above is unreachable.
  expect(MAX_SUBMISSION_BYTES).toBeLessThanOrEqual(256 * 1024);

  // And nothing was written: a refusal that still filed the lead would be a
  // cap in name only.
  const [row] = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, orgId),
        eq(schema.contacts.email, "toomuch@buyer.example"),
      ),
    );
  expect(row).toBeUndefined();
});

test("a submission with a great many fields keeps only a form's worth", async () => {
  // Not a person filling in a form. Bounded so a thousand-key body cannot turn
  // into a thousand custom values on a contact record.
  const many: Record<string, string> = {
    name: "Wide Load",
    email: "wide@buyer.example",
  };
  for (let i = 0; i < 500; i += 1) many[`field${i}`] = "x";

  const res = await submit(contactFormKey, many);
  expect(res.status).toBeLessThan(400);

  const [submission] = await db
    .select({ payload: schema.formSubmissions.payload })
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId))
    .orderBy(desc(schema.formSubmissions.createdAt))
    .limit(1);
  const kept = Object.keys(
    (submission?.payload ?? {}) as Record<string, unknown>,
  );
  expect(kept.length).toBeLessThanOrEqual(100);
});

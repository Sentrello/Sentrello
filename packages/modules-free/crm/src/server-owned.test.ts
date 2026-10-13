import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { memberWith, signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import crm from "./index";

/**
 * The columns only the server writes are not the body's to choose.
 *
 * The CRM factory spread a request into the row, so a picture's file name, a
 * portal login, the author of a note and the form reply a deal came from were
 * all writable by anybody who could edit a contact. The picture is the sharp
 * one: its name is joined onto the images directory to serve the file, so
 * `../../../../etc/hosts` was a read of anything the process can open.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(crm);
const otherOrg = `server-owned-other-${suffix}`;
let orgId: string;
let userId: string;
let otherUserId: string;
let headers: Headers;

const ESCAPE = "../../../../../../../../etc/hosts";

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `server-owned-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `Server owned ${suffix}`, slug: `server-owned-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("no session");
  userId = session.user.id;

  // Somebody of another business, whose name must never be put on our note.
  await makeOrganization(otherOrg);
  const other = await signUpAsOwner({
    email: `server-owned-stranger-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Stranger",
  });
  const strangerSession = await auth.api.getSession({
    headers: new Headers({ cookie: other.headers.get("set-cookie") ?? "" }),
  });
  if (!strangerSession) throw new Error("no session");
  otherUserId = strangerSession.user.id;
});

afterAll(async () => {
  await dropOrganization(orgId, otherOrg);
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("a contact cannot be made or edited with a picture path, a portal login or a chosen id", async () => {
  const chosen = crypto.randomUUID();
  const made = await send("POST", "/api/contacts", {
    id: chosen,
    name: "Pictured",
    avatarPath: ESCAPE,
    portalToken: "chosen-token",
    portalUserId: otherUserId,
  });
  expect(made.status).toBe(201);
  const { contact } = (await made.json()) as { contact: { id: string } };
  expect(contact.id).not.toBe(chosen);

  const edited = await send("PATCH", `/api/contacts/${contact.id}`, {
    name: "Pictured again",
    avatarPath: ESCAPE,
    portalUserId: otherUserId,
  });
  expect(edited.status).toBe(200);

  const [row] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contact.id));
  expect(row?.avatarPath).toBeNull();
  expect(row?.portalUserId).toBeNull();
  expect(row?.portalToken ?? null).toBeNull();
  expect(row?.name).toBe("Pictured again");
});

test("a picture name with a directory in it is never served or deleted", async () => {
  const made = await send("POST", "/api/companies", { name: "Logo'd" });
  const { company } = (await made.json()) as { company: { id: string } };
  // However it got into the column, it is not a file of ours.
  await db
    .update(schema.companies)
    .set({ logoPath: ESCAPE })
    .where(eq(schema.companies.id, company.id));

  const served = await send("GET", `/api/crm/companies/${company.id}/image`);
  expect(served.status).toBe(404);
  expect(await served.text()).not.toContain("localhost");

  const removed = await send(
    "DELETE",
    `/api/crm/companies/${company.id}/image`,
  );
  expect(removed.status).toBe(404);
});

test("an edit cannot say a note was written by somebody else", async () => {
  const contact = (await (
    await send("POST", "/api/contacts", { name: "Noted" })
  ).json()) as {
    contact: { id: string };
  };
  const made = await send("POST", "/api/notes", {
    entityType: "contact",
    entityId: contact.contact.id,
    text: "Call them back on Tuesday",
    authorId: otherUserId,
  });
  expect(made.status).toBe(201);
  const { note } = (await made.json()) as {
    note: { id: string; authorId: string };
  };
  expect(note.authorId).toBe(userId);

  await send("PATCH", `/api/notes/${note.id}`, {
    authorId: otherUserId,
    text: "Tuesday, after two",
  });
  const [row] = await db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.id, note.id));
  expect(row?.authorId).toBe(userId);
  expect(row?.text).toBe("Tuesday, after two");
});

/**
 * A customer's portal login is not on any screen a CRM reader opens.
 *
 * The resource routes strip it, and the three screens a record opens on read
 * the row whole and answered it whole. `crm:read` with no invoicing at all —
 * the seeded marketing policy — was handed every customer's token, and
 * `/account/:token` shows that customer's invoices, balance and payments to
 * whoever holds it, with no session.
 */
test("the contact, company and deal screens do not carry the portal login", async () => {
  const reader = await memberWith({
    organizationId: orgId,
    ownerHeaders: headers,
    permission: { crm: ["read"] },
    email: `server-owned-reader-${suffix}@example.test`,
    role: `crm-reader-${suffix}`,
  });
  const token = `portal-login-${crypto.randomUUID()}`;
  const [company] = await db
    .insert(schema.companies)
    .values({ organizationId: orgId, name: "Ellis & Daughters" })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Margaret Ellis",
      companyId: company?.id,
      portalToken: token,
    })
    .returning();
  if (!company || !contact) throw new Error("could not make the records");
  const [deal] = await db
    .insert(schema.deals)
    .values({
      organizationId: orgId,
      name: "Ellis refit",
      stage: "lead",
      companyId: company.id,
      contactIds: [contact.id],
    })
    .returning();
  if (!deal) throw new Error("could not make the deal");

  try {
    for (const path of [
      `/api/contacts/${contact.id}/related`,
      `/api/companies/${company.id}/related`,
      `/api/deals/${deal.id}/related`,
    ]) {
      const res = await app.request(`http://localhost${path}`, {
        headers: reader.headers,
      });
      expect(res.status, path).toBe(200);
      const text = await res.text();
      // The screen still has the person on it, and not their login.
      expect(text, path).toContain("Margaret Ellis");
      expect(text, path).not.toContain(token);
      expect(text, path).not.toContain("portalToken");
    }
  } finally {
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, reader.userId));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, reader.userId));
    await db
      .delete(schema.member)
      .where(eq(schema.member.userId, reader.userId));
    await db.delete(schema.user).where(eq(schema.user.id, reader.userId));
  }
});

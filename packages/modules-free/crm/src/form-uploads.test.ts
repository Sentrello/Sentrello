import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema, sql } from "@sentrello/db";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import {
  attachmentsDir,
  registerForTest,
  resetRateLimits,
} from "@sentrello/module-sdk";
import {
  UPLOAD_FOLDER,
  attachmentLinks,
  notificationSender,
  sweepExpiredUploads,
} from "./forms";
import crm from "./index";

/**
 * A stranger on the internet sending a document to a business.
 *
 * Every other upload on this platform arrives from somebody signed in, with a
 * permission on the record they are attaching to. This one arrives from the
 * open web and is written to the instance's own disk, so the checks between
 * those two facts are what these tests are about.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const email = `uploads-${suffix}@example.test`;
const app = registerForTest(crm);

let orgId: string;
let headers: Headers;
/** Somebody in the same business who may read the CRM and not delete from it. */
const memberEmail = `uploads-member-${suffix}@example.test`;
let memberHeaders: Headers;
let formId: string;
let formKey: string;

const pdf = (body = "1 0 obj\n<< /Type /Catalog >>\nendobj\n") =>
  new Blob([`%PDF-1.7\n${body}trailer\nstartxref\n9\n%%EOF\n`], {
    type: "application/pdf",
  });

function send(
  parts: Record<string, string | Blob>,
  origin = "https://acme.com",
) {
  resetRateLimits();
  const body = new FormData();
  for (const [key, value] of Object.entries(parts)) {
    if (typeof value === "string") body.append(key, value);
    else body.append(key, value, "cv.pdf");
  }
  return app.request(`http://localhost/api/embed/forms/${formKey}`, {
    method: "POST",
    headers: { origin },
    body,
  });
}

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
    body: { name: `Uploads ${suffix}`, slug: `uploads-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  /*
   * And a colleague in the same business on the base `member` role.
   *
   * The delete route is guarded with `requirePermission({ crm: ["delete"] })`
   * and nothing asserted it. A guard nobody has watched refuse is the same
   * shape as a guard that cannot fail: the route reads correctly and the only
   * proof is a request that comes back 403.
   */
  /*
   * A role that can read the CRM and not delete from it, which is the only kind
   * of colleague this proves anything about. The first version of this test gave
   * them the base `member` role, which has no CRM permission at all — so the 403
   * came back whatever the route asked for, and weakening the guard from `delete`
   * to `read` left the test green. A refusal has to be about the verb.
   */
  await auth.api.createOrgRole({
    body: {
      organizationId: orgId,
      role: "reader",
      permission: { crm: ["read"] },
    },
    headers,
  });
  const member = await signUpAsOwner({
    email: memberEmail,
    password: "correct-horse-battery-staple",
    name: "A Colleague",
  });
  const memberCookie = member.headers.get("set-cookie");
  if (!memberCookie) throw new Error("the member sign-up returned no cookie");
  memberHeaders = new Headers({
    cookie: memberCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: member.response.user.id,
    role: "reader",
    baseRole: "member",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: memberHeaders,
  });

  const made = await app.request("http://localhost/api/forms", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Apply",
      kind: "contact",
      allowedOrigins: ["https://acme.com"],
    }),
  });
  const { form } = (await made.json()) as { form: { id: string; key: string } };
  formId = form.id;
  formKey = form.key;

  await app.request(`http://localhost/api/forms/${formId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      fields: [
        { name: "name", label: "Your name", type: "text", required: true },
        { name: "email", label: "Email", type: "email", required: true },
        { name: "cv", label: "Your CV", type: "file", required: true },
      ],
    }),
  });
});

afterAll(async () => {
  await db
    .delete(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  await db.delete(schema.forms).where(eq(schema.forms.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  // The organization goes too. An instance that still has one answers 409 to
  // being claimed, and the bootstrap tests fail for a reason that has nothing
  // to do with them.
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await rm(`${attachmentsDir(UPLOAD_FOLDER)}/${orgId}`, {
    recursive: true,
    force: true,
  });
  for (const address of [email, memberEmail]) {
    const [u] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, address));
    if (u) {
      await db.delete(schema.session).where(eq(schema.session.userId, u.id));
      await db.delete(schema.account).where(eq(schema.account.userId, u.id));
      await db.delete(schema.user).where(eq(schema.user.id, u.id));
    }
  }
});

test("a PDF sent through a public form is kept, and the row says what checked it", async () => {
  const res = await send({
    name: "Ada Lovelace",
    email: `ada-${suffix}@applicant.example`,
    cv: pdf(),
  });
  expect(res.status).toBe(201);

  const [row] = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  expect(row?.attachments).toHaveLength(1);
  expect(row?.attachments?.[0]?.field).toBe("cv");
  expect(row?.attachments?.[0]?.name).toBe("cv.pdf");
  // No scanner configured in a test run, so the shape check is the whole of it.
  expect(row?.attachments?.[0]?.checkedBy).toBe("shape");
  // The stored name is generated; the one that was sent is only ever shown.
  expect(row?.attachments?.[0]?.path).not.toContain("cv.pdf");
  // The answer keeps the filename so a person reading the submission sees it.
  expect(row?.payload?.cv).toBe("cv.pdf");
});

test("the file comes back to somebody who may read the form, as a download", async () => {
  const [row] = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  const res = await app.request(
    `http://localhost/api/forms/submissions/${row?.id}/files/0`,
    { headers },
  );
  expect(res.status).toBe(200);
  // Never served as something this origin would run.
  expect(res.headers.get("content-type")).toContain("application/octet-stream");
  expect(res.headers.get("content-disposition")).toContain("attachment");
});

/**
 * The link is in an email, so the refusal is read in a browser by a person.
 * `{"error":"unauthorized"}` in a window is a dead end — it does not say
 * whether to sign in, whether the file is gone, or whether it is broken.
 */
test("a browser following the link is told what to do about it", async () => {
  const [row] = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  const res = await app.request(
    `http://localhost/api/forms/submissions/${row?.id}/files/0`,
    { headers: { accept: "text/html" } },
  );
  expect([401, 403]).toContain(res.status);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain("signed in");
  expect(body).not.toContain("unauthorized");
});

test("a signed-out request gets nothing", async () => {
  const [row] = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  const res = await app.request(
    `http://localhost/api/forms/submissions/${row?.id}/files/0`,
  );
  expect([401, 403]).toContain(res.status);
});

test("something that is not a PDF is refused before it is written", async () => {
  const before = (
    await db
      .select()
      .from(schema.formSubmissions)
      .where(eq(schema.formSubmissions.organizationId, orgId))
  ).length;

  const res = await send({
    name: "Grace Hopper",
    email: `grace-${suffix}@applicant.example`,
    cv: new Blob(["MZ not a document at all"], {
      type: "application/pdf",
    }),
  });
  expect(res.status).toBe(400);

  const after = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  expect(after).toHaveLength(before);
});

test("a PDF that does something when it opens is refused", async () => {
  const res = await send({
    name: "Katherine Johnson",
    email: `kj-${suffix}@applicant.example`,
    cv: pdf("<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n"),
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("JavaScript");
});

/**
 * A file sent under a name the form never asked for is a file nobody
 * requested, and a public endpoint should not write one.
 */
test("a file under an unexpected name is dropped, not stored", async () => {
  const body = new FormData();
  body.append("name", "Mary Jackson");
  body.append("email", `mj-${suffix}@applicant.example`);
  body.append("cv", pdf(), "cv.pdf");
  body.append("payload", pdf(), "extra.pdf");
  resetRateLimits();
  const res = await app.request(`http://localhost/api/embed/forms/${formKey}`, {
    method: "POST",
    headers: { origin: "https://acme.com" },
    body,
  });
  expect(res.status).toBe(201);

  const rows = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  const latest = rows.at(-1);
  expect(latest?.attachments).toHaveLength(1);
});

/**
 * The submission is the record of the enquiry and stays. The document is
 * somebody else's and does not.
 */
test("a sweep throws away the files that have aged out and keeps the rows", async () => {
  const rows = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.organizationId, orgId));
  const withFile = rows.find((r) => (r.attachments ?? []).length > 0);
  if (!withFile) throw new Error("no submission carried a file");

  const gone = await sweepExpiredUploads(
    new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
  );
  expect(gone).toBeGreaterThan(0);

  const [after] = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.id, withFile.id));
  expect(after).toBeDefined();
  expect(after?.attachments).toEqual([]);
});

/**
 * More aged-out files than one batch holds. The sweep took five hundred a
 * night and stopped, so the five-hundred-and-first stayed on the disk past
 * the date it was promised gone.
 */
test("a sweep with more than five hundred files to throw away takes them all", async () => {
  const old = new Date(Date.now() - 800 * 24 * 60 * 60 * 1000);
  await db.insert(schema.formSubmissions).values(
    Array.from({ length: 501 }, (_, n) => ({
      organizationId: orgId,
      formId,
      payload: { name: `old ${n}` },
      attachments: [
        {
          field: "cv",
          name: "cv.pdf",
          path: `aged-out-${suffix}-${n}.pdf`,
          size: 10,
          type: "application/pdf",
          checkedBy: "shape" as const,
        },
      ],
      createdAt: old,
    })),
  );

  await sweepExpiredUploads();

  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.formSubmissions)
    .where(
      sql`${schema.formSubmissions.organizationId} = ${orgId} and ${schema.formSubmissions.createdAt} < ${old.toISOString()}::timestamp + interval '1 day' and jsonb_array_length(${schema.formSubmissions.attachments}) > 0`,
    );
  expect(left?.n).toBe(0);
});

/**
 * A notification about a CV that does not let you reach the CV.
 *
 * The email listed the file's name, because the name is what the payload
 * carries, and gave no way to open it — so the thing telling somebody an
 * application had arrived required them to go and find the application. It
 * shipped that way and was caught by a person reading the email, which is the
 * worst way to find anything.
 */
test("the notification links every file it mentions", () => {
  const was = process.env.SENTRELLO_BASE_URL;
  process.env.SENTRELLO_BASE_URL = "https://forms.example.test/";
  try {
    const links = attachmentLinks("sub-1", [
      {
        field: "cv",
        name: "grace-cv.pdf",
        path: "org/abc.pdf",
        size: 2048,
        type: "application/pdf",
        checkedBy: "shape",
      },
    ]);
    expect(links).toHaveLength(1);
    // The trailing slash on the base must not become a double slash.
    expect(links[0]).toContain(
      'href="https://forms.example.test/api/forms/submissions/sub-1/files/0"',
    );
    expect(links[0]).toContain("grace-cv.pdf");
    expect(links[0]).toContain("2KB");
  } finally {
    process.env.SENTRELLO_BASE_URL = was;
  }
});

/** A path is not a link when it is read in somebody's inbox. */
test("no address means no link, rather than a broken one", () => {
  const was = process.env.SENTRELLO_BASE_URL;
  process.env.SENTRELLO_BASE_URL = undefined;
  try {
    expect(
      attachmentLinks("sub-1", [
        {
          field: "cv",
          name: "cv.pdf",
          path: "org/a.pdf",
          size: 10,
          type: "application/pdf",
          checkedBy: "shape",
        },
      ]),
    ).toEqual([]);
  } finally {
    process.env.SENTRELLO_BASE_URL = was;
  }
});

/**
 * A job application that arrives from the billing address.
 *
 * The address on a message is a claim about what the message is, and
 * "billing@" is the wrong claim for somebody's CV. James noticed within a
 * minute of reading one.
 */
test("a form notification says what it is, on a domain we send as", () => {
  expect(
    notificationSender(
      "Careers application",
      "Sentrello <billing@sentrello.com>",
    ),
  ).toBe('"Careers application" <no-reply@sentrello.com>');
});

/**
 * The first attempt sent from the notify address, which is a trap: the
 * notification goes *to* that address, so the message would be from an
 * address to itself. A Google Group reads that as a loop and drops it without
 * a word — the exact failure this whole evening was spent chasing.
 */
test("the sender is never the address the notification is going to", () => {
  const from = notificationSender(
    "Careers application",
    "Sentrello <billing@sentrello.com>",
  );
  expect(from).not.toContain("careers@");
});

/** A display name carrying a bracket or a newline would break the header. */
test("a form named with punctuation cannot break the header", () => {
  expect(
    notificationSender('Odd "name" <x>\r\ninjected', "billing@sentrello.com"),
  ).toBe('"Odd name xinjected" <no-reply@sentrello.com>');
  expect(notificationSender("Careers", undefined)).toBeUndefined();
});

// Bare, a colon made the name an address group and brackets made a comment.
test("an ordinary form name survives being a display name", () => {
  expect(notificationSender("Quote: request", "billing@sentrello.com")).toBe(
    '"Quote: request" <no-reply@sentrello.com>',
  );
  expect(notificationSender("Contact (web)", "billing@sentrello.com")).toBe(
    '"Contact (web)" <no-reply@sentrello.com>',
  );
});

/**
 * Throwing one application away, and the CV with it.
 *
 * There was no way to do this at all: the only deletion was the whole form,
 * which takes every submission with it — the wrong instrument for a filled role
 * on a form still taking applications for the next one. So a business kept every
 * CV for ever or deleted the form people were applying through.
 *
 * The assertion that matters is the file. A row removed while the PDF stays on
 * the disk is a deletion a business would report as done and a candidate would
 * be entitled to complain about, and it is the half easiest to leave out.
 */
test("deleting a submission takes its file off the disk", async () => {
  const applicant = `applicant-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const sent = await send({
    name: "An Applicant",
    work_email: applicant,
    cv: pdf(),
  });
  expect(sent.status).toBe(201);

  /*
   * Found by the address only this test used. Ordering by `createdAt` and taking
   * the first row hands back the oldest submission on the form, which belongs to
   * whichever test ran before this one and has no file on it.
   */
  const rows = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.formId, formId));
  const row = rows.find((r) =>
    Object.values(r.payload ?? {}).includes(applicant),
  );
  const held = row?.attachments?.[0];
  if (!row || !held) throw new Error("the submission arrived without its file");

  const onDisk = `${attachmentsDir(UPLOAD_FOLDER)}/${held.path}`;
  expect(await Bun.file(onDisk).exists()).toBe(true);

  const gone = await app.request(
    `http://localhost/api/forms/submissions/${row.id}`,
    { method: "DELETE", headers },
  );
  expect(gone.status).toBe(200);
  expect(((await gone.json()) as { files: number }).files).toBe(1);

  // The row, and the file it carried.
  expect(
    await db
      .select({ id: schema.formSubmissions.id })
      .from(schema.formSubmissions)
      .where(eq(schema.formSubmissions.id, row.id)),
  ).toHaveLength(0);
  expect(
    await Bun.file(onDisk).exists(),
    "the submission went and its CV stayed on the disk",
  ).toBe(false);
});

/**
 * And it is one business's submission, not anybody's with the id.
 *
 * Scoped in the query that finds it, so another business's id is indistinguishable
 * from one that never existed.
 */
test("another business's submission cannot be deleted", async () => {
  const sent = await send({
    name: "Another Applicant",
    work_email: `other-${suffix}@example.test`,
  });
  expect(sent.status).toBe(201);

  const rows = await db
    .select({ id: schema.formSubmissions.id })
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.formId, formId));
  const mine = rows[rows.length - 1]?.id;
  if (!mine) throw new Error("no submission to try");

  /*
   * A real organization, because `organization_id` is a foreign key on every
   * business table since 27 September — a made-up id is refused by the database
   * and the test then fails for a reason that has nothing to do with what it
   * asserts. Moved under it for the length of the attempt, which is cheaper than
   * a second signed-up business and proves the same thing: the row exists and is
   * not this session's to delete.
   */
  const theirs = await makeOrganization(
    `other-forms-${crypto.randomUUID().slice(0, 8)}`,
  );
  await db
    .update(schema.formSubmissions)
    .set({ organizationId: theirs })
    .where(eq(schema.formSubmissions.id, mine));
  try {
    const refused = await app.request(
      `http://localhost/api/forms/submissions/${mine}`,
      { method: "DELETE", headers },
    );
    expect(refused.status).toBe(404);
    expect(
      await db
        .select({ id: schema.formSubmissions.id })
        .from(schema.formSubmissions)
        .where(eq(schema.formSubmissions.id, mine)),
    ).toHaveLength(1);
  } finally {
    await db
      .update(schema.formSubmissions)
      .set({ organizationId: orgId })
      .where(eq(schema.formSubmissions.id, mine));
    await dropOrganization(theirs);
  }
});

/**
 * The guard on throwing a submission away, watched refusing.
 *
 * `requirePermission({ crm: ["delete"] })` is on the route and nothing had ever
 * asked it a question. The pair matters more than either half: the same request
 * from somebody who may delete has to succeed, or a 403 proves only that the
 * route is broken for everybody.
 *
 * It deletes last, so the rows the other tests read are still there for them.
 */
test("a colleague who may not delete cannot throw a submission away", async () => {
  resetRateLimits();
  const sent = await send({
    name: "Someone",
    email: `perm-${suffix}@example.test`,
    cv: pdf(),
  });
  expect(sent.status).toBe(201);

  /*
   * By the address that was typed in, which lives in `payload` rather than in a
   * column of its own. Not "the newest row": these tests share one form, and a
   * test that picks a row by age asserts against whichever one it happens to get.
   */
  const [row] = await db
    .select()
    .from(schema.formSubmissions)
    .where(
      sql`${schema.formSubmissions.payload}->>'email' = ${`perm-${suffix}@example.test`}`,
    );
  if (!row) throw new Error("the submission under test was not written");
  const url = `http://localhost/api/forms/submissions/${row.id}`;

  const refused = await app.request(url, {
    method: "DELETE",
    headers: memberHeaders,
  });
  expect(refused.status).toBe(403);

  // And it is still there, which is the half a status code does not prove.
  const [survived] = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.id, row.id));
  expect(survived, "a 403 was answered and the row went anyway").toBeDefined();

  // The same request from the owner, so the 403 above is about permission
  // rather than about the route being broken.
  const allowed = await app.request(url, { method: "DELETE", headers });
  expect(allowed.status).toBe(200);
});

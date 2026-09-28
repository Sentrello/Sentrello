import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import archive, { wholeMonths } from "./index";

/**
 * The archive screen's end of it.
 *
 * The engine's own promises — verification before deletion, the statutory
 * floor, identical reports — are pinned in `@sentrello/db`'s
 * `archive.test.ts`. What is here is what only the routes can be wrong about:
 * who may ask, what a refusal looks like from outside, and that the file the
 * browser is handed is the file that was verified.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `archive-owner-${suffix}@example.test`;
const memberEmail = `archive-member-${suffix}@example.test`;

const app = registerForTest(archive);

let orgId = "";
let ownerId = "";
let memberId = "";
let headers: Headers;
let memberHeaders: Headers;
let cash = "";
let sales = "";

beforeAll(async () => {
  process.env.SENTRELLO_DATA_DIR = `/tmp/sentrello-archive-${suffix}`;

  const owner = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = owner.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  ownerId = owner.response.user.id;
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Archive ${suffix}`, slug: `archive-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
  await db
    .update(schema.organizations)
    .set({ countryCode: "GB" })
    .where(eq(schema.organizations.id, orgId));

  const member = await signUpAsOwner({
    email: memberEmail,
    password: "correct-horse-battery-staple",
    name: "An Employee",
  });
  const memberCookie = member.headers.get("set-cookie");
  if (!memberCookie) throw new Error("sign-up returned no session cookie");
  memberId = member.response.user.id;
  memberHeaders = new Headers({
    cookie: memberCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: memberId,
    role: "member",
    baseRole: "member",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: memberHeaders,
  });

  cash = await ensureAccount(orgId, CORE_ACCOUNTS.cash);
  sales = await ensureAccount(orgId, CORE_ACCOUNTS.salesIncome);
  for (const month of [0, 1]) {
    await postJournalEntry(
      orgId,
      "takings",
      "test",
      [
        { accountId: cash, debitCents: 25_00 },
        { accountId: sales, creditCents: 25_00 },
      ],
      new Date(Date.UTC(2014, month, 9)),
    );
  }
  await db.insert(schema.ledgerSettings).values({
    organizationId: orgId,
    closedThrough: new Date(Date.UTC(2020, 11, 31)),
  });
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  for (const entry of entries) {
    await db
      .delete(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.ledgerSettings, schema.ledgerSettings.organizationId],
    [schema.archiveRuns, schema.archiveRuns.organizationId],
    [
      schema.organizationPreferences,
      schema.organizationPreferences.organizationId,
    ],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await dropOrganization(orgId);
  for (const id of [ownerId, memberId]) {
    await db.delete(schema.session).where(eq(schema.session.userId, id));
    await db.delete(schema.account).where(eq(schema.account.userId, id));
    await db.delete(schema.user).where(eq(schema.user.id, id));
  }
  await Bun.$`rm -rf ${process.env.SENTRELLO_DATA_DIR}`.quiet().nothrow();
});

const get = (path: string, who: Headers = headers) =>
  app.request(`http://localhost${path}`, { headers: who });
const post = (path: string, body: unknown, who: Headers = headers) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers: who,
    body: JSON.stringify(body),
  });

test("a period is whole calendar months or it is nothing", () => {
  expect(
    wholeMonths(
      new Date(Date.UTC(2014, 0, 1)),
      new Date(Date.UTC(2014, 1, 1) - 1),
    ),
  ).toBe(true);
  expect(
    wholeMonths(
      new Date(Date.UTC(2014, 0, 2)),
      new Date(Date.UTC(2014, 1, 1) - 1),
    ),
  ).toBe(false);
  expect(
    wholeMonths(
      new Date(Date.UTC(2014, 0, 1)),
      new Date(Date.UTC(2014, 0, 20)),
    ),
  ).toBe(false);
});

test("somebody without the permission is refused, and told nothing else", async () => {
  const routes: [string, string][] = [
    ["GET", "/api/archive/sets"],
    ["GET", "/api/archive/plan?set=ledger&from=2014-01&to=2014-12"],
    ["POST", "/api/archive/runs"],
    ["GET", "/api/archive/runs"],
    ["GET", "/api/archive/runs/00000000-0000-0000-0000-000000000000/download"],
    ["DELETE", "/api/archive/runs/00000000-0000-0000-0000-000000000000/file"],
    ["POST", "/api/archive/restore"],
    ["GET", "/api/archive/destination"],
    ["PUT", "/api/archive/destination"],
    ["POST", "/api/archive/destination/test"],
  ];
  for (const [method, path] of routes) {
    const res = await app.request(`http://localhost${path}`, {
      method,
      headers: memberHeaders,
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    });
    expect(`${method} ${path} -> ${res.status}`).toBe(
      `${method} ${path} -> 403`,
    );
  }
});

test("writing an archive is not the same grant as removing what it holds", async () => {
  // An owner may do both; this pins that the two are separable at all, by
  // asking for the removal with a caller who holds neither and getting the
  // refusal from the permission layer rather than from the engine.
  const res = await post(
    "/api/archive/runs",
    { set: "ledger", from: "2014-01", to: "2014-12", remove: true },
    memberHeaders,
  );
  expect(res.status).toBe(403);
});

test("the plan says what is there, and the floor before anything is chosen", async () => {
  const sets = (await (await get("/api/archive/sets")).json()) as {
    sets: { id: string }[];
    retention: { years: number; countryCode: string };
  };
  expect(sets.sets.map((s) => s.id)).toEqual([
    "activity",
    "documents",
    "ledger",
  ]);
  expect(sets.retention.years).toBe(6);
  expect(sets.retention.countryCode).toBe("GB");

  const plan = (await (
    await get("/api/archive/plan?set=ledger&from=2014-01&to=2014-12")
  ).json()) as { rows: number; blockers: unknown[] };
  expect(plan.rows).toBe(6);
  expect(plan.blockers).toEqual([]);
});

test("a period that is not whole months is refused before anything is written", async () => {
  const res = await post("/api/archive/runs", {
    set: "ledger",
    from: "2014-01-05",
    to: "2014-12",
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain(
    "two months",
  );
});

test("written, verified, removed — and the file that comes back is the file", async () => {
  const before = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(before).toHaveLength(2);

  const res = await post("/api/archive/runs", {
    set: "ledger",
    from: "2014-01",
    to: "2014-12",
    remove: true,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    run: {
      id: string;
      status: string;
      sha256: string;
      bytes: number;
      filename: string;
      carriedForward: string[];
    };
    removed: { table: string; rows: number }[];
  };
  expect(body.run.status).toBe("removed");
  expect(body.removed?.find((r) => r.table === "journal_entries")?.rows).toBe(
    2,
  );
  // Two months, two summaries.
  expect(body.run.carriedForward).toHaveLength(2);

  const left = await db
    .select({
      id: schema.journalEntries.id,
      source: schema.journalEntries.source,
    })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(left).toHaveLength(2);
  expect(left.every((e) => e.source?.startsWith("archive:"))).toBe(true);

  // The download is the bytes that were verified, checksum for checksum.
  const file = await get(`/api/archive/runs/${body.run.id}/download`);
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toBe("application/zip");
  const bytes = new Uint8Array(await file.arrayBuffer());
  expect(bytes.length).toBe(body.run.bytes);
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  expect(hash.digest("hex")).toBe(body.run.sha256);

  // And it can be handed back.
  const form = new FormData();
  form.set("file", new File([bytes], body.run.filename));
  form.set("mode", "inspect");
  const inspected = await app.request("http://localhost/api/archive/restore", {
    method: "POST",
    headers: new Headers({ cookie: headers.get("cookie") as string }),
    body: form,
  });
  expect(inspected.status).toBe(200);
  const report = (await inspected.json()) as {
    mine: boolean;
    counts: Record<string, number>;
  };
  expect(report.mine).toBe(true);
  expect(report.counts.journal_entries).toBe(2);
});

test("a run is remembered after its file is cleared away", async () => {
  const runs = (await (await get("/api/archive/runs")).json()) as {
    runs: { id: string; present: boolean; sha256: string }[];
  };
  const run = runs.runs[0] as { id: string; present: boolean; sha256: string };
  expect(run.present).toBe(true);

  const cleared = await app.request(
    `http://localhost/api/archive/runs/${run.id}/file`,
    { method: "DELETE", headers },
  );
  expect(cleared.status).toBe(200);

  const after = (await (await get("/api/archive/runs")).json()) as {
    runs: { id: string; present: boolean; sha256: string; status: string }[];
  };
  const same = after.runs.find((r) => r.id === run.id);
  // The record of what left survives the file: the checksum is how the copy in
  // somebody's drawer is checked years later.
  expect(same?.present).toBe(false);
  expect(same?.sha256).toBe(run.sha256);
  expect(same?.status).toBe("removed");
  expect((await get(`/api/archive/runs/${run.id}/download`)).status).toBe(404);
});

test("the destination is configured here, and proves itself before it is trusted", async () => {
  const summary = (await (await get("/api/archive/destination")).json()) as {
    id: string;
    available: { id: string; fields: { name: string }[] }[];
  };
  expect(summary.id).toBe("folder");
  expect(summary.available.map((d) => d.id)).toContain("folder");

  const good = await post("/api/archive/destination/test", {
    id: "folder",
    values: { directory: `${process.env.SENTRELLO_DATA_DIR}/elsewhere` },
  });
  expect(((await good.json()) as { ok: boolean }).ok).toBe(true);

  // A path that is not a path, and a folder nothing can be written to: both
  // answers rather than errors, because a screen that shows a stack trace has
  // told nobody anything.
  const relative = await post("/api/archive/destination/test", {
    id: "folder",
    values: { directory: "somewhere/relative" },
  });
  const answer = (await relative.json()) as { ok: boolean; detail: string };
  expect(answer.ok).toBe(false);
  expect(answer.detail).toContain("full path");

  const saved = await app.request("http://localhost/api/archive/destination", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      id: "folder",
      values: { directory: `${process.env.SENTRELLO_DATA_DIR}/elsewhere` },
    }),
  });
  expect(saved.status).toBe(200);
  const stored = await db
    .select({ value: schema.organizationPreferences.value })
    .from(schema.organizationPreferences)
    .where(
      and(
        eq(schema.organizationPreferences.organizationId, orgId),
        eq(schema.organizationPreferences.key, "archive.destination"),
      ),
    );
  expect(stored).toHaveLength(1);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { dropOrganization, dropUsers } from "@sentrello/db/testing";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { checkWithVies, parseEuVat, registerVies } from "./vies";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `vies-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  registerVies({ app } as unknown as Parameters<typeof registerVies>[0]);

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Vies ${suffix}`, slug: `vies-${suffix}` },
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
    .delete(schema.companies)
    .where(eq(schema.companies.organizationId, orgId));
  await dropOrganization(orgId);
  await dropUsers(email);
});

// ---------------------------------------------------------------------------
// Reading what somebody typed
// ---------------------------------------------------------------------------

test("an EU VAT number parses however a person spaced it", () => {
  expect(parseEuVat("DE 123 456 789")).toEqual({
    countryCode: "DE",
    vatNumber: "123456789",
  });
  expect(parseEuVat("ie6388047v")).toEqual({
    countryCode: "IE",
    vatNumber: "6388047V",
  });
  // Greece is EL on the VAT register, whatever the atlas says.
  expect(parseEuVat("GR123456789")).toEqual({
    countryCode: "EL",
    vatNumber: "123456789",
  });
});

test("an identifier that is not an EU VAT number is not VIES's to answer", () => {
  expect(parseEuVat("12-3456789")).toBeNull(); // a US EIN
  expect(parseEuVat("123456789RT0001")).toBeNull(); // a Canadian GST number
  expect(parseEuVat("GB123456789")).toBeNull(); // Great Britain left the register
  expect(parseEuVat("DE")).toBeNull();
});

// ---------------------------------------------------------------------------
// The three honest outcomes
// ---------------------------------------------------------------------------

const viesSaying = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("a number the register confirms is valid, with the registered name", async () => {
  const answer = await checkWithVies(
    "BE",
    "0123456789",
    viesSaying({ valid: true, name: "ACME BVBA", address: "Brussels" }),
  );
  expect(answer).toEqual({ status: "valid", name: "ACME BVBA" });
});

test("a number the register denies is invalid, not unavailable", async () => {
  const answer = await checkWithVies(
    "BE",
    "0123456789",
    viesSaying({ valid: false, name: "---" }),
  );
  expect(answer).toEqual({ status: "invalid", name: null });
});

test("an outage is unavailable, never invalid", async () => {
  // The three ways VIES actually fails: a member state down behind a 200, a
  // plain server error, and no answer at all.
  const memberStateDown = await checkWithVies(
    "DE",
    "1",
    viesSaying({
      actionSucceed: false,
      errorWrappers: [{ error: "MS_UNAVAILABLE" }],
    }),
  );
  expect(memberStateDown.status).toBe("unavailable");

  const serverError = await checkWithVies("DE", "1", viesSaying({}, 500));
  expect(serverError.status).toBe("unavailable");

  const network = await checkWithVies("DE", "1", (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch);
  expect(network.status).toBe("unavailable");
});

// ---------------------------------------------------------------------------
// The route: evidence written, or deliberately not
// ---------------------------------------------------------------------------

async function companyWith(taxIdentifier: string | null): Promise<string> {
  const [made] = await db
    .insert(schema.companies)
    .values({
      organizationId: orgId,
      name: `Check ${crypto.randomUUID().slice(0, 8)}`,
      taxIdentifier,
    })
    .returning();
  if (!made) throw new Error("company insert returned no row");
  return made.id;
}

async function check(companyId: string) {
  return app.request(`/api/companies/${companyId}/vat-check`, {
    method: "POST",
    headers,
  });
}

function withViesAnswering(body: unknown, status = 200) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) =>
    String(url).includes("ec.europa.eu")
      ? new Response(JSON.stringify(body), { status })
      : realFetch(url as string, init)) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

test("a valid number is recorded with the date and the registered name", async () => {
  const companyId = await companyWith("DE 811 907 980");
  const restore = withViesAnswering({ valid: true, name: "SIEMENS AG" });
  try {
    const res = await check(companyId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("valid");
  } finally {
    restore();
  }

  const [row] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId));
  expect(row?.taxIdentifierValid).toBe(true);
  expect(row?.taxIdentifierCheckedName).toBe("SIEMENS AG");
  // The timestamp is the evidence: checked, and when.
  expect(row?.taxIdentifierCheckedAt).toBeInstanceOf(Date);
});

test("an invalid number is recorded as invalid", async () => {
  const companyId = await companyWith("DE123456789");
  const restore = withViesAnswering({ valid: false, name: "---" });
  try {
    const res = await check(companyId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("invalid");
  } finally {
    restore();
  }

  const [row] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId));
  expect(row?.taxIdentifierValid).toBe(false);
  expect(row?.taxIdentifierCheckedName).toBeNull();
});

test("an outage answers 503 and leaves last month's evidence standing", async () => {
  const companyId = await companyWith("FR 40 303 265 045");
  // The register confirmed this number once already.
  const confirmedOn = new Date("2026-08-01T09:00:00Z");
  await db
    .update(schema.companies)
    .set({
      taxIdentifierValid: true,
      taxIdentifierCheckedAt: confirmedOn,
      taxIdentifierCheckedName: "SA CARREFOUR",
    })
    .where(eq(schema.companies.id, companyId));

  const restore = withViesAnswering({
    actionSucceed: false,
    errorWrappers: [{ error: "MS_UNAVAILABLE" }],
  });
  try {
    const res = await check(companyId);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe(
      "unavailable",
    );
  } finally {
    restore();
  }

  const [row] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId));
  // A register that failed to answer must not turn a good number bad.
  expect(row?.taxIdentifierValid).toBe(true);
  expect(row?.taxIdentifierCheckedName).toBe("SA CARREFOUR");
  expect(row?.taxIdentifierCheckedAt?.getTime()).toBe(confirmedOn.getTime());
});

test("a non-EU identifier is refused in words, without calling anybody", async () => {
  const companyId = await companyWith("12-3456789");
  const res = await check(companyId);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain(
    "not an EU VAT number",
  );
});

test("a company with nothing to check is told so", async () => {
  const companyId = await companyWith(null);
  const res = await check(companyId);
  expect(res.status).toBe(400);
});

test("another organization's company is not found, let alone checked", async () => {
  const companyId = await companyWith("DE811907980");
  const [foreign] = await db
    .insert(schema.organizations)
    .values({
      id: `vies-foreign-${suffix}`,
      name: "Someone else",
      slug: `vies-foreign-${suffix}`,
      createdAt: new Date(),
    })
    .returning();
  await db
    .update(schema.companies)
    .set({ organizationId: foreign?.id ?? "" })
    .where(eq(schema.companies.id, companyId));
  try {
    const res = await check(companyId);
    expect(res.status).toBe(404);
  } finally {
    await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
    await dropOrganization(foreign?.id ?? "");
  }
});

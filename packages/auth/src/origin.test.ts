import { expect, test } from "bun:test";
import { explainOrigin } from "./hono";

/**
 * "Invalid origin" is the right refusal and a useless explanation.
 *
 * The person reading it is almost always the owner of a self-hosted instance
 * who reached their own app by a name SENTRELLO_BASE_URL does not mention — an
 * IP, localhost, www. where the setting has the bare domain. Two words with no
 * pointer to the setting turns a one-line fix into a support conversation. I
 * hit it myself, while already knowing the cause.
 */

const refusal = () =>
  Response.json(
    { message: "Invalid origin", code: "INVALID_ORIGIN" },
    { status: 403 },
  );

test("the refusal names the setting and both addresses", async () => {
  const res = await explainOrigin(refusal(), "https://www.example.com");
  expect(res.status).toBe(403);

  const body = (await res.json()) as { message: string; code: string };
  expect(body.code).toBe("INVALID_ORIGIN");
  expect(body.message).toContain("SENTRELLO_BASE_URL");
  // Both sides of the mismatch, so nothing is left to work out.
  expect(body.message).toContain("https://www.example.com");
  expect(body.message).toContain(
    process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000",
  );
});

test("a request with no origin at all still gets a usable sentence", async () => {
  const body = (await (await explainOrigin(refusal(), undefined)).json()) as {
    message: string;
  };
  expect(body.message).toContain("an unknown origin");
  expect(body.message).toContain("SENTRELLO_BASE_URL");
});

test("other refusals are left exactly as they were", async () => {
  // Only this one message is rewritten. A permission failure must keep the
  // shape every client already handles.
  const forbidden = Response.json(
    { message: "You are not allowed", code: "FORBIDDEN" },
    { status: 403 },
  );
  const out = await explainOrigin(forbidden, "https://example.com");
  expect(((await out.json()) as { code: string }).code).toBe("FORBIDDEN");
});

test("a wrong password is not touched", async () => {
  const unauthorised = Response.json(
    { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" },
    { status: 401 },
  );
  const out = await explainOrigin(unauthorised, "https://example.com");
  expect(out.status).toBe(401);
  expect(((await out.json()) as { code: string }).code).toBe(
    "INVALID_EMAIL_OR_PASSWORD",
  );
});

test("a successful sign-in passes straight through", async () => {
  const ok = Response.json({ user: { id: "u1" } }, { status: 200 });
  const out = await explainOrigin(ok, "https://example.com");
  expect(out.status).toBe(200);
  expect(await out.json()).toEqual({ user: { id: "u1" } });
});

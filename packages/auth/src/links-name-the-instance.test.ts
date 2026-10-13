import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { baseUrl } from "@sentrello/db/base-url";
import { auth } from "./index";
import { signUpAsOwner } from "./testing";

/**
 * A reset link is ours, whoever asked for it.
 *
 * Anybody can ask for a password reset, and the request carries whatever Host
 * header they like. Were the link built from that, the account holder would
 * get a genuine email from us pointing at the asker's domain, with a live
 * token in it. The library builds it from `baseURL`, which is fixed here; this
 * pins that, and pins the list a callback is checked against, because the
 * library skips that check under test and the handler cannot show it.
 */

const email = `reset-host-${crypto.randomUUID().slice(0, 8)}@example.test`;

afterAll(async () => {
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!u) return;
  await db.delete(schema.session).where(eq(schema.session.userId, u.id));
  await db.delete(schema.account).where(eq(schema.account.userId, u.id));
  await db.delete(schema.user).where(eq(schema.user.id, u.id));
});

test("a reset asked for under another Host still emails a link to this instance", async () => {
  await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Reset Host",
  });

  const realFetch = globalThis.fetch;
  const savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_never_sent";
  const sent: string[] = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://api.resend.com/")) {
      sent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ id: "stubbed" }), { status: 200 });
    }
    throw new Error(`a test asked the real network for ${url}`);
  }) as typeof fetch;

  try {
    const res = await auth.handler(
      new Request("http://evil.example/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          host: "evil.example",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email }),
      }),
    );
    expect(res.status).toBe(200);
    // The mail goes after the answer, so wait for it.
    for (let i = 0; i < 100 && sent.length === 0; i++) {
      await Bun.sleep(20);
    }
    expect(sent).toHaveLength(1);
    const { html } = JSON.parse(sent[0] ?? "{}") as { html: string };
    expect(html).not.toContain("evil.example");
    expect(html).toContain(`${baseUrl()}/api/auth/reset-password/`);
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey === undefined)
      Reflect.deleteProperty(process.env, "RESEND_API_KEY");
    else process.env.RESEND_API_KEY = savedKey;
  }
});

test("a callback is this instance or a plain path on it, never somewhere else", async () => {
  const ctx = await auth.$context;
  // Fixed, and only ours: nothing on the list is read from a request.
  expect(ctx.baseURL).toBe(`${baseUrl()}/api/auth`);
  expect(
    typeof (auth.options as { trustedOrigins?: unknown }).trustedOrigins,
  ).not.toBe("function");
  expect(ctx.trustedOrigins).not.toContain("*");

  const asCallback = { allowRelativePaths: true };
  for (const elsewhere of [
    "//evil.example",
    "/\\evil.example",
    "/%2fevil.example",
    "https://evil.example/profile",
    "javascript:alert(1)",
  ]) {
    expect(ctx.isTrustedOrigin(elsewhere, asCallback)).toBe(false);
  }
  expect(ctx.isTrustedOrigin("/profile", asCallback)).toBe(true);
  expect(ctx.isTrustedOrigin(`${baseUrl()}/profile`, asCallback)).toBe(true);
});

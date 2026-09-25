import { afterEach, expect, test } from "bun:test";
import { emailAdapter } from "./index";

/**
 * A header a stranger wrote, on its way into somebody's mail server.
 *
 * A carriage return or newline inside a header value ends that header and
 * begins another — the oldest trick in SMTP. It matters here because one of
 * these headers is not ours: the CRM's public form puts whatever address a
 * visitor typed into `Reply-To`, so hitting reply on an enquiry writes back
 * to the person who sent it. The check at that call site is that the string
 * contains an `@`, which `me@example.com\r\nBcc: everyone@…` passes happily.
 *
 * Both adapters hand `headers` straight to somebody else, and both of them
 * probably cope. "Probably cope" is not a thing to build a public endpoint
 * on, so the guard is at the one door every message in this product goes
 * through — and this is the test that says so, by watching what leaves.
 */

const saved = {
  key: process.env.RESEND_API_KEY,
  from: process.env.EMAIL_FROM,
};
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of [
    ["RESEND_API_KEY", saved.key],
    ["EMAIL_FROM", saved.from],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Sends one message through the Resend adapter and returns what it posted. */
async function sent(
  message: Parameters<ReturnType<typeof emailAdapter>["send"]>[0],
) {
  process.env.RESEND_API_KEY = "test-key-not-a-real-one";
  process.env.EMAIL_FROM = "billing@example.test";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await emailAdapter().send(message);
  return body;
}

test("a Reply-To carrying a second header never leaves the building", async () => {
  const body = await sent({
    to: "owner@example.test",
    subject: "A new enquiry",
    html: "<p>Hello</p>",
    headers: {
      "Reply-To": "visitor@example.test\r\nBcc: everyone@example.test",
    },
  });
  // Dropped whole, not trimmed: half of somebody's attempt is still an
  // address the business never chose to write to.
  expect(JSON.stringify(body)).not.toContain("Bcc");
  expect(JSON.stringify(body)).not.toContain("visitor@example.test");
});

test("an ordinary header goes through untouched", async () => {
  const body = await sent({
    to: "reader@example.test",
    subject: "Your invoices",
    html: "<p>Hello</p>",
    headers: {
      "List-Unsubscribe": "<https://example.test/u/abc>",
      "Reply-To": "visitor@example.test",
    },
  });
  const headers = (body as { headers?: Record<string, string> }).headers ?? {};
  expect(headers["List-Unsubscribe"]).toBe("<https://example.test/u/abc>");
  expect(headers["Reply-To"]).toBe("visitor@example.test");
});

/**
 * The subject is a header too. Every subject in this product is written by
 * the product, so this is the belt rather than the braces — but a subject
 * carrying a form's own name is one template away, and that name comes from
 * whoever set the form up.
 */
test("a subject cannot start a second header either", async () => {
  const body = await sent({
    to: "owner@example.test",
    subject: "A new enquiry\r\nBcc: everyone@example.test",
    html: "<p>Hello</p>",
  });
  expect(String(body.subject)).toBe("A new enquiry Bcc: everyone@example.test");
  expect(String(body.subject)).not.toContain("\n");
});

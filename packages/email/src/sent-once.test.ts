import { afterEach, expect, test } from "bun:test";
import { emailAdapter } from "./index";

/**
 * A message that arrived although the answer did not.
 *
 * The send has a fifteen-second deadline, and a provider that accepted the
 * message and was slow to say so looks exactly like one that never got it. The
 * overdue chase releases its claim on any failure and tries again an hour
 * later, so the customer was asked twice. A key the provider has already seen
 * makes the second ask return the first answer rather than a second letter.
 */
const saved = { key: process.env.RESEND_API_KEY, fetch: globalThis.fetch };

afterEach(() => {
  process.env.RESEND_API_KEY = saved.key ?? "";
  globalThis.fetch = saved.fetch;
});

function provider(answer: () => Response) {
  const seen: Headers[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return answer();
  }) as typeof fetch;
  return seen;
}

const message = {
  to: "ines@example.test",
  subject: "INV-1 is overdue",
  html: "<p>Please pay</p>",
};

test("a message with a key carries it to the provider", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const seen = provider(() => Response.json({ id: "1" }));
  await emailAdapter().send({ ...message, idempotencyKey: "overdue/inv/rule" });
  expect(seen[0]?.get("idempotency-key")).toBe("overdue/inv/rule");
});

test("a key the provider already sent under is a message already sent", async () => {
  process.env.RESEND_API_KEY = "re_test";
  provider(() =>
    Response.json(
      { name: "invalid_idempotent_request", message: "already used" },
      { status: 409 },
    ),
  );
  // Resolves: the balance in the letter moved since the first try, which is
  // why the bodies differ, and the customer already has the first one.
  await emailAdapter().send({ ...message, idempotencyKey: "overdue/inv/rule" });
});

test("a send still in flight under the same key is not counted as sent", async () => {
  process.env.RESEND_API_KEY = "re_test";
  provider(() =>
    Response.json(
      { name: "concurrent_idempotent_requests", message: "in progress" },
      { status: 409 },
    ),
  );
  await expect(
    emailAdapter().send({ ...message, idempotencyKey: "overdue/inv/rule" }),
  ).rejects.toThrow();
});

test("a message without a key sends no key", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const seen = provider(() => Response.json({ id: "1" }));
  await emailAdapter().send(message);
  expect(seen[0]?.has("idempotency-key")).toBe(false);
});

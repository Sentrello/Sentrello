import { expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIp } from "./index";

/**
 * A rate-limit key the caller can choose is not a rate limit.
 *
 * Behind the bundled nginx these paths were safe, because nginx always sets
 * `x-real-ip` and the forgeable fallback never fired. On an instance reached
 * directly — the on-premises case — it fired every time, and each attacker
 * picked their own bucket.
 */
const app = new Hono().get("/who", (c) => c.text(clientIp(c)));

test("the trusted header is used when the proxy sets it", async () => {
  const res = await app.request("http://localhost/who", {
    headers: { "x-real-ip": "203.0.113.7" },
  });
  expect(await res.text()).toBe("203.0.113.7");
});

test("a forged x-forwarded-for is ignored entirely", async () => {
  const res = await app.request("http://localhost/who", {
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  const key = await res.text();
  expect(key).not.toBe("203.0.113.9");
  expect(key).not.toContain("203.0.113.9");
});

test("a forged x-forwarded-for cannot displace the trusted header", async () => {
  const res = await app.request("http://localhost/who", {
    headers: {
      "x-real-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.9",
    },
  });
  expect(await res.text()).toBe("203.0.113.7");
});

test("two callers forging different values share one bucket, rather than getting one each", async () => {
  const first = await (
    await app.request("http://localhost/who", {
      headers: { "x-forwarded-for": "198.51.100.1" },
    })
  ).text();
  const second = await (
    await app.request("http://localhost/who", {
      headers: { "x-forwarded-for": "198.51.100.2" },
    })
  ).text();
  // Over-limiting is the safe direction for a rate limiter. Handing each
  // forged value its own bucket is the failure this task exists to remove.
  expect(first).toBe(second);
});

test("a deployment behind a different proxy is believed when it names its header", async () => {
  const previous = process.env.SENTRELLO_CLIENT_IP_HEADER;
  process.env.SENTRELLO_CLIENT_IP_HEADER = "cf-connecting-ip";
  try {
    const res = await app.request("http://localhost/who", {
      headers: { "cf-connecting-ip": "203.0.113.11" },
    });
    expect(await res.text()).toBe("203.0.113.11");
  } finally {
    process.env.SENTRELLO_CLIENT_IP_HEADER = previous;
  }
});

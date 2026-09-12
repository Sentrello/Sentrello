import { expect, test } from "bun:test";
import {
  maySignIn,
  sessionDomain,
  withinSessionDomain,
} from "./customer-session";

/**
 * The domain an instance shares with its own shop's website.
 *
 * The important case is the one that must never happen: an instance at the apex
 * of its domain must not decide it shares `com` with everybody.
 */
test("the shared domain is one somebody already controls", () => {
  expect(sessionDomain("sentrello.barkerpawski.com")).toBe("barkerpawski.com");
  expect(sessionDomain("shop.acme.co.uk")).toBe("acme.co.uk");
  expect(sessionDomain("a.b.c.example.com")).toBe("b.c.example.com");

  // At the apex, it keeps the apex. Stripping a label here gives "com", and a
  // shared domain of "com" makes every website on earth same-site with this
  // instance — the one mistake worth writing a test for.
  expect(sessionDomain("barkerpawski.com")).toBe("barkerpawski.com");
  expect(sessionDomain("example.org")).toBe("example.org");
  expect(sessionDomain("co.uk")).toBe("co.uk");

  // No dots at all: itself, and nothing else.
  expect(sessionDomain("localhost")).toBe("localhost");
  expect(sessionDomain("")).toBeNull();

  // A port is not part of a domain.
  expect(sessionDomain("sentrello.barkerpawski.com:3000")).toBe(
    "barkerpawski.com",
  );
});

test("a host is within a domain only when it really is", () => {
  expect(withinSessionDomain("barkerpawski.com", "barkerpawski.com")).toBe(
    true,
  );
  expect(withinSessionDomain("www.barkerpawski.com", "barkerpawski.com")).toBe(
    true,
  );
  expect(
    withinSessionDomain("sentrello.barkerpawski.com", "barkerpawski.com"),
  ).toBe(true);

  /*
   * The attack this shape invites: a domain somebody else registered that ends
   * with the same letters. `notbarkerpawski.com` is not within
   * `barkerpawski.com`, and a check written with `endsWith` and no dot would
   * say it was.
   */
  expect(withinSessionDomain("notbarkerpawski.com", "barkerpawski.com")).toBe(
    false,
  );
  expect(
    withinSessionDomain("barkerpawski.com.evil.test", "barkerpawski.com"),
  ).toBe(false);
  expect(withinSessionDomain("barkerpawski.co", "barkerpawski.com")).toBe(
    false,
  );
  expect(withinSessionDomain("anything.test", null)).toBe(false);
});

/**
 * The whole decision, as a route asks it.
 *
 * Both conditions have to hold, and the refusals have to say which failed —
 * a shop setting this up and getting nothing needs to be told whether it forgot
 * to list the site or put the site on the wrong domain.
 */
test("a customer signs in only from a listed site on the same domain", () => {
  const instance = "https://sentrello.barkerpawski.com";

  // The shop's own website, listed: yes.
  expect(maySignIn("https://barkerpawski.com", instance, true).ok).toBe(true);
  expect(maySignIn("https://www.barkerpawski.com", instance, true).ok).toBe(
    true,
  );

  // Listed, but a different domain entirely. Browsers will not carry a session
  // there, so offering one would be offering something that does not work.
  const elsewhere = maySignIn("https://barkerpawski-shop.com", instance, true);
  expect(elsewhere.ok).toBe(false);
  expect(elsewhere.reason).toContain("barkerpawski.com");

  // Same domain, but the shop never listed it.
  const unlisted = maySignIn("https://blog.barkerpawski.com", instance, false);
  expect(unlisted.ok).toBe(false);
  expect(unlisted.reason).toContain("list");

  // Neither.
  expect(maySignIn("https://somewhere.else", instance, false).ok).toBe(false);

  // No Origin is the instance talking to itself, or a client that is not a
  // browser: nothing cross-site is happening and there is nothing to refuse.
  expect(maySignIn(undefined, instance, true).ok).toBe(true);

  // Nonsense is refused rather than parsed generously.
  expect(maySignIn("not a url", instance, true).ok).toBe(false);
});

/** An instance at the apex of its own domain still works, and stays narrow. */
test("an instance at the apex shares only itself and its subdomains", () => {
  const instance = "https://barkerpawski.com";
  expect(maySignIn("https://barkerpawski.com", instance, true).ok).toBe(true);
  expect(maySignIn("https://shop.barkerpawski.com", instance, true).ok).toBe(
    true,
  );
  // And emphatically not everybody else on .com.
  expect(maySignIn("https://example.com", instance, true).ok).toBe(false);
});

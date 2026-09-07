import { afterAll, afterEach, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { auth } from "./index";
import {
  allowSignupFor,
  setupTokenAccepted,
  setupTokenRequired,
  signUpAllowed,
} from "./signup-policy";

const suffix = crypto.randomUUID().slice(0, 8);
const orgId = `signup-policy-${suffix}`;
const password = "correct-horse-battery-staple";
const createdEmails: string[] = [];

async function withOrganization<T>(fn: () => Promise<T>): Promise<T> {
  await db.insert(schema.organizations).values({
    id: orgId,
    name: `Policy ${suffix}`,
    slug: `policy-${suffix}`,
    createdAt: new Date(),
  });
  try {
    return await fn();
  } finally {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
  }
}

afterEach(() => {
  process.env.SENTRELLO_ALLOW_SIGNUP = undefined;
});

afterAll(async () => {
  for (const email of createdEmails) {
    const [u] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (!u) continue;
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

test("once claimed, an uninvited stranger is refused", async () => {
  await withOrganization(async () => {
    const decision = await signUpAllowed("stranger@example.test", false);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("closed");
  });
});

test("a pending invitation lets exactly that address through", async () => {
  await withOrganization(async () => {
    const invited = `invited-${suffix}@example.test`;
    // the inviter is a real user: the table has a foreign key to it
    const inviterId = `inviter-${suffix}`;
    await db.insert(schema.user).values({
      id: inviterId,
      name: "Inviter",
      email: `inviter-${suffix}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.invitation).values({
      id: `inv-${suffix}`,
      organizationId: orgId,
      email: invited,
      role: "staff",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId,
    });

    expect((await signUpAllowed(invited, false)).allowed).toBe(true);
    expect(
      (await signUpAllowed("someone-else@example.test", false)).allowed,
    ).toBe(false);

    await db
      .delete(schema.invitation)
      .where(eq(schema.invitation.id, `inv-${suffix}`));
    await db.delete(schema.user).where(eq(schema.user.id, inviterId));
  });
});

test("the opt-in reopens registration for anyone who wants that", async () => {
  await withOrganization(async () => {
    expect((await signUpAllowed("stranger@example.test", true)).allowed).toBe(
      true,
    );
  });
});

test("the guard actually blocks the HTTP sign-up endpoint", async () => {
  await withOrganization(async () => {
    const email = `blocked-${suffix}@example.test`;
    createdEmails.push(email);

    const attempt = auth.api.signUpEmail({
      body: { email, password, name: "Blocked" },
    });
    await expect(attempt).rejects.toThrow();

    // and nothing was written
    const rows = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    expect(rows).toHaveLength(0);
  });
});

test("the setup token is compared exactly, and in constant time", () => {
  const expected = "s3cret-setup-token";
  expect(setupTokenAccepted("s3cret-setup-token", expected)).toBe(true);
  expect(setupTokenAccepted("s3cret-setup-toke", expected)).toBe(false); // short
  expect(setupTokenAccepted("s3cret-setup-tokenX", expected)).toBe(false); // long
  expect(setupTokenAccepted("S3CRET-SETUP-TOKEN", expected)).toBe(false); // case
  expect(setupTokenAccepted("", expected)).toBe(false);
  expect(setupTokenAccepted(undefined, expected)).toBe(false);
});

test("with no token configured, none is demanded", () => {
  expect(setupTokenAccepted(undefined, undefined)).toBe(true);
  expect(setupTokenRequired(undefined)).toBe(false);
  expect(setupTokenRequired("anything")).toBe(true);
});

test("a fresh instance still refuses a direct sign-up: claiming goes through bootstrap", async () => {
  // no organization exists in this branch, which used to be enough on its own
  const decision = await signUpAllowed("first-comer@example.test", false);
  expect(decision.allowed).toBe(false);
});

/**
 * How sentrello.com creates a billing account at checkout: the server itself
 * asks for one address, and the endpoint stays closed to everyone else — both
 * during that call and after it.
 */
test("the server can create an account for one named address, and only that one", async () => {
  await withOrganization(async () => {
    const buyer = `buyer-${suffix}@example.test`;

    await allowSignupFor(buyer, async () => {
      expect((await signUpAllowed(buyer, false)).allowed).toBe(true);
      // Same window, different address: still closed. A plain flag would have
      // opened registration to the whole internet for these few milliseconds.
      expect(
        (await signUpAllowed("stranger@example.test", false)).allowed,
      ).toBe(false);
    });

    // And it closes behind itself, even for the address it was opened for.
    expect((await signUpAllowed(buyer, false)).allowed).toBe(false);
  });
});

test("the allowance is released even when creating the account throws", async () => {
  await withOrganization(async () => {
    const buyer = `throws-${suffix}@example.test`;
    await expect(
      allowSignupFor(buyer, async () => {
        throw new Error("Stripe said no");
      }),
    ).rejects.toThrow("Stripe said no");

    expect((await signUpAllowed(buyer, false)).allowed).toBe(false);
  });
});

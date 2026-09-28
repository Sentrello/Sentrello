import { expect, test } from "bun:test";
import { db, schema } from "./index";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * A failed sign-in has no actor.
 *
 * The address may belong to nobody. `actor_id` was `NOT NULL` because every
 * event until now was an administrator doing something; the events that matter
 * on a public login page are the ones with no account behind them.
 */
test("an event can be recorded with no actor", async () => {
  // The organization is real because the row has to name one: every business
  // table has carried a foreign key to it since 2026-09-27.
  const orgId = await makeOrganization(`schema-test-${crypto.randomUUID()}`);
  try {
    const [row] = await db
      .insert(schema.securityEvents)
      .values({
        organizationId: orgId,
        actorId: null,
        actorName: null,
        action: "sign-in.failed",
        detail: { email: "nobody@example.test" },
      })
      .returning();
    expect(row?.actorId).toBeNull();
  } finally {
    await dropOrganization(orgId);
  }
});

test("the policy carries lockout and retention settings with safe defaults", async () => {
  // The organization is real because the row has to name one: every business
  // table has carried a foreign key to it since 2026-09-27.
  const orgId = await makeOrganization(`schema-test-${crypto.randomUUID()}`);
  try {
    const [row] = await db
      .insert(schema.securityPolicy)
      .values({ organizationId: orgId })
      .returning();
    expect(row?.lockoutAfterAttempts).toBe(5);
    expect(row?.lockoutMinutes).toBe(15);
    expect(row?.eventRetentionDays).toBe(365);
  } finally {
    await dropOrganization(orgId);
  }
});

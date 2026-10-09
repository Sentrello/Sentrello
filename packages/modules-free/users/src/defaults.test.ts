import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, inArray, schema } from "@sentrello/db";
import {
  DEFAULT_GROUPS,
  DEFAULT_GROUP_POLICIES,
  DEFAULT_TILL_POLICIES,
  DEFAULT_USER_POLICIES,
  policyLabel,
  seedDefaults,
} from "./defaults";
import { BUILT_IN } from "./roles";

/*
 * Every seeded policy, and the till ones have to be in here.
 *
 * This was the two older lists, so the three added for a counter on 7 October
 * were outside the reserved-name check and outside "every policy can reach the
 * page it lands on" — a policy that signs in to nowhere would have seeded
 * happily. The checks below are about *what the seed writes*, so the list is
 * what the seed writes.
 */
const all = [
  ...DEFAULT_USER_POLICIES,
  ...DEFAULT_GROUP_POLICIES,
  ...DEFAULT_TILL_POLICIES,
];
const byName = new Map(all.map((p) => [p.name, p]));

/**
 * Staff and Accounting stopped being compiled into the product, so a business
 * can edit them like every other default. The migration that made that safe
 * had to write their permissions into the database as literal JSON, which is a
 * second copy of something that already exists in this file.
 *
 * A second copy of a permission set is a screen telling an administrator
 * something the permission checks disagree with, and they would believe the
 * screen. This is the only thing keeping the two honest.
 */
const migration = readFileSync(
  join(
    import.meta.dir,
    "../../../db/drizzle/0038_staff_and_accounting_become_data.sql",
  ),
  "utf8",
);

describe("the migration and the defaults agree", () => {
  for (const name of ["staff", "accounting"]) {
    test(`${name} is written into the database exactly as this file defines it`, () => {
      const policy = byName.get(name);
      expect(policy).toBeDefined();
      const inSql = migration.match(
        new RegExp(`\\('${name}', '(\\{.*?\\})'\\)`),
      )?.[1];
      expect(inSql).toBeDefined();

      /**
       * Compared resource by resource, over what the migration wrote.
       *
       * A migration is a record of what was true when it ran, and it has run:
       * changing it now would give a new instance different permissions from
       * one that upgraded. So the defaults are allowed to have grown since —
       * `docs` was added to several of them after this — but they must not
       * *disagree* with it about anything it named. A resource quietly
       * narrowed here and left wide in the database is the drift worth
       * catching.
       */
      const written = JSON.parse(inSql as string) as Record<string, string[]>;
      const now = (policy?.permission ?? {}) as Record<string, string[]>;
      for (const [resource, actions] of Object.entries(written)) {
        expect({ resource, actions: now[resource] }).toEqual({
          resource,
          actions,
        });
      }
    });
  }

  test("it leaves a name the business already used alone", () => {
    // A business that made its own Staff before this keeps it. Overwriting one
    // would silently change what somebody's colleagues are allowed to do.
    expect(migration).toContain("WHERE NOT EXISTS");
  });

  test("it does not touch who holds what", () => {
    // Only what a role may do changes. A migration that edited `member` would
    // be one that can lock people out of their own instance.
    //
    // The statements, not the comments — the note above this migration says
    // the word `member` in order to promise it does not touch it, and reading
    // the file whole makes that promise fail its own test.
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\bmember\b/i);
    expect(statements).toContain("organization_role");
  });
});

describe("what a business may not name its own role", () => {
  test("only the two that genuinely cannot be data", () => {
    // Every name here is one the owner can never use. `admin` exists before
    // any organization does; `customer` is assigned by the portal rather than
    // chosen. Staff and Accounting were here, and being here was the only
    // reason they could not be edited.
    expect([...BUILT_IN]).toEqual(["admin", "customer"]);
  });

  test("no default policy claims a reserved name", () => {
    // Better Auth refuses the name, so a default that collided would fail to
    // seed and the business would silently be one policy short.
    const reserved = new Set<string>(BUILT_IN);
    const clashes = all.map((p) => p.name).filter((n) => reserved.has(n));
    expect(clashes).toEqual([]);
  });

  test("staff and accounting are ordinary defaults now", () => {
    for (const name of ["staff", "accounting"]) {
      const policy = byName.get(name);
      expect(policy).toBeDefined();
      // No opt-out flag survives: they are created by the seed like the rest.
      expect(Object.keys(policy ?? {})).not.toContain("compiled");
      expect(Object.keys(policy?.permission ?? {}).length).toBeGreaterThan(0);
    }
  });
});

/**
 * What the shipped policies actually allow.
 *
 * These assertions used to live beside the compiled roles in the auth package,
 * because that is where Staff and Accounting were defined. They are the
 * business's own roles now, so the permissions moved here and the tests came
 * with them — a policy's contents should be asserted where the policy lives,
 * or the two drift and the tests keep passing.
 */
describe("what the shipped policies allow", () => {
  const may = (name: string, resource: string, action: string): boolean =>
    (byName.get(name)?.permission?.[resource] ?? []).includes(action);

  test("accounting does the books and sends invoices, but manages nobody", () => {
    expect(may("accounting", "invoicing", "send")).toBe(true);
    expect(may("accounting", "bookkeeping", "create")).toBe(true);
    expect(may("accounting", "reports", "read")).toBe(true);
    expect(may("accounting", "member", "create")).toBe(false);
    expect(may("accounting", "settings", "update")).toBe(false);
  });

  test("staff works the CRM and touches no money", () => {
    // The boundary that matters in a business of five people: whoever does the
    // work is not also the person who can raise and send a bill for it.
    expect(may("staff", "crm", "create")).toBe(true);
    expect(may("staff", "invoicing", "read")).toBe(true);
    expect(may("staff", "invoicing", "create")).toBe(false);
    expect(may("staff", "invoicing", "send")).toBe(false);
    expect(may("staff", "bookkeeping", "read")).toBe(false);
  });

  test("every policy can reach the page it lands on", () => {
    // A role without dashboard:read signs in to nowhere.
    for (const policy of all) {
      expect({
        policy: policy.name,
        lands: (policy.permission?.dashboard ?? []).includes("read"),
      }).toEqual({ policy: policy.name, lands: true });
    }
  });
});

/**
 * Paying a supplier is not a bookkeeping action.
 *
 * Categorising a transaction and sending money out of the business's bank are
 * different jobs, so they are different grants. A bookkeeper reconciles all
 * day and has no business paying anybody; whoever approves payments may never
 * touch the ledger.
 *
 * Asserted on the defaults rather than described in a comment, because the
 * whole value of the split is that it holds for the roles a business actually
 * gets on day one — and the easy mistake is to add the resource and then hand
 * it to everybody.
 */
const EVERY_DEFAULT = [...DEFAULT_USER_POLICIES, ...DEFAULT_GROUP_POLICIES];

test("only the administrators can pay anybody", () => {
  const canSend = EVERY_DEFAULT.filter((role) =>
    (role.permission.payments ?? []).includes("send"),
  ).map((role) => role.name);
  expect(canSend).toEqual(["admins"]);

  const canConnect = EVERY_DEFAULT.filter((role) =>
    (role.permission.payments ?? []).includes("connect"),
  ).map((role) => role.name);
  expect(canConnect).toEqual(["admins"]);
});

test("the bookkeeper sees what was paid and pays nobody", () => {
  const accounting = EVERY_DEFAULT.find((role) => role.name === "accounting");
  expect(accounting).toBeTruthy();

  // The whole job is the books, and a payment out of the bank belongs on them.
  expect(accounting?.permission.payments).toEqual(["read"]);
  // And the ledger is still entirely theirs.
  expect(accounting?.permission.bookkeeping).toEqual([
    "read",
    "create",
    "update",
    "delete",
  ]);
});

/**
 * And nobody gets it by accident.
 *
 * A resource added to the statement and then granted in a role somebody
 * copied is how a permission split quietly stops splitting anything.
 */
test("no other default role can move money", () => {
  for (const role of EVERY_DEFAULT) {
    if (role.name === "admins") continue;
    const granted = role.permission.payments ?? [];
    expect(
      granted.includes("send") || granted.includes("connect"),
      `${role.name} can move money`,
    ).toBe(false);
  }
});

/**
 * Seeded once and permanently — but only if it was actually seeded.
 *
 * `createOrgRole` re-authorises the caller against `ac: ["create"]` on their
 * own role, which only the compiled `admin` carries. Every refusal was
 * swallowed and the "already seeded" marker went down anyway, so a business
 * whose first visit to the Policies screen came from somebody without that
 * statement was left with no policies at all, permanently, and nothing
 * anywhere said so.
 */
test("a seed that could write nothing is not marked as done", async () => {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      id: crypto.randomUUID(),
      name: `Unseedable ${crypto.randomUUID().slice(0, 8)}`,
      slug: `unseedable-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: new Date(),
    })
    .returning();
  if (!org) throw new Error("no organization");

  try {
    // No session at all, so every `createOrgRole` is refused.
    const first = await seedDefaults(org.id, new Headers());
    expect(first.seeded).toBe(false);

    const [after] = await db
      .select({ seededAt: schema.organizations.accessSeededAt })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id))
      .limit(1);
    // Not stamped: an administrator opening the screen can still seed it.
    expect(after?.seededAt ?? null).toBeNull();
  } finally {
    await db
      .delete(schema.userGroups)
      .where(eq(schema.userGroups.organizationId, org.id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
  }
});

/**
 * The customer policy opens nothing in the product.
 *
 * It granted `invoicing: ["read"]` until 2026-09-28, on the reasoning that
 * the portal would narrow it to that person's own invoices. The portal is
 * reached by a 32-byte token with no session and no permission check, so
 * the grant did nothing there — and `GET /api/invoices` scopes by
 * organization and takes `contactId` as a filter the caller supplies. So
 * a login holding this policy could read the whole business's invoice
 * book, while three published pages promised "their own invoices, nothing
 * else, and there is no setting that widens it".
 *
 * Asserted as an exact set rather than "does not include invoicing", so
 * that anything added here has to be argued for.
 */
test("a customer's policy grants nothing but the page they land on", () => {
  const customers = DEFAULT_USER_POLICIES.find((p) => p.name === "customers");
  expect(customers).toBeDefined();
  expect(customers?.permission).toEqual({ dashboard: ["read"] });
});

/**
 * What the documentation tells somebody they will find on first run.
 *
 * Two published pages described these wrongly at once and differently: one
 * named three policies out of five and promoted a group policy to a role, the
 * other counted the groups as four when six are seeded. Nobody notices,
 * because the page is read by people who have not installed it yet and the
 * code is read by people who have.
 *
 * So the counts are pinned against the documentation rather than against a
 * comment. A seventh group is a fine thing to add; adding it without touching
 * the page that promises six is not.
 */
test("the seeded defaults are the ones the documentation promises", async () => {
  expect(DEFAULT_USER_POLICIES.map((p) => p.name)).toEqual([
    "admins",
    "executives",
    "managers",
    "staff",
    "customers",
  ]);
  expect(DEFAULT_GROUP_POLICIES.map((p) => p.name)).toEqual([
    "sales",
    "marketing",
    "accounting",
    "customer service",
  ]);
  /*
   * And the three for a counter, which are given to a person like a seniority
   * rather than backing a department. Nothing seeded here granted a single `pos`
   * permission until 7 October 2026, so the only person who could work a till
   * was the instance owner.
   */
  expect(DEFAULT_TILL_POLICIES.map((p) => p.name)).toEqual([
    "till",
    "till supervisors",
    "till managers",
  ]);
  expect(DEFAULT_GROUPS.map((g) => g.name)).toEqual([
    "Admins",
    "Sales",
    "Marketing",
    "Accounting",
    "Customer Service",
    "Customers",
    "Till",
  ]);

  /*
   * And the tour names every one of them.
   *
   * By name rather than by sentence. This used to pin the exact words "Five
   * policies out of the box" and "Six groups as well", which made improving the
   * paragraph a failing test — and the cheapest way out of a failing test about
   * prose is to edit the test. What matters is that a reader is told the same
   * set the product seeds, whatever the sentence around it.
   */
  const page = await Bun.file(
    `${import.meta.dir}/../../../../docs/site/01-getting-started/what-it-looks-like.md`,
  ).text();
  const named = page.toLowerCase();
  for (const policy of DEFAULT_USER_POLICIES) {
    expect(named).toContain(policyLabel(policy.name).toLowerCase());
  }
  for (const group of DEFAULT_GROUPS) {
    expect(named).toContain(group.name.toLowerCase());
  }
  // And the totals, because a page can list them all and still miscount out
  // loud — the Free-versus-Pro table says nine and six, and the two pages
  // disagreeing about one number is the fault this pins.
  expect(named).toContain("five policies");
  expect(named).toContain("seven groups");
  expect(named).toContain("twelve policies and seven groups");
});

/**
 * An organization seeded before the till's policies gets them, once.
 *
 * Seeded today and then made to look like one seeded in September: the three
 * till policies and the Till group taken away, the stamp put back before they
 * shipped. One of the three is left in place and edited, the way an
 * administrator might have made their own "till supervisors" — it has to come
 * through untouched. And once caught up, a policy deleted again stays deleted.
 */
test("an organization seeded before the till's policies gets them, once", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const signUp = await signUpAsOwner({
    email: `till-catch-up-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `Till catch-up ${suffix}`, slug: `till-catch-up-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });

  const roles = schema.organizationRole;
  const tillRole = (name: string) =>
    and(eq(roles.organizationId, org.id), eq(roles.role, name));
  const roleNames = async () =>
    (
      await db
        .select({ role: roles.role })
        .from(roles)
        .where(eq(roles.organizationId, org.id))
    ).map((r) => r.role);

  try {
    expect((await seedDefaults(org.id, headers)).seeded).toBe(true);

    const theirs = JSON.stringify({ dashboard: ["read"], pos: ["read"] });
    await db
      .update(roles)
      .set({ permission: theirs })
      .where(tillRole("till supervisors"));
    await db
      .delete(roles)
      .where(
        and(
          eq(roles.organizationId, org.id),
          inArray(roles.role, ["till", "till managers"]),
        ),
      );
    await db
      .delete(schema.userGroups)
      .where(
        and(
          eq(schema.userGroups.organizationId, org.id),
          eq(schema.userGroups.name, "Till"),
        ),
      );
    await db
      .update(schema.organizations)
      .set({ accessSeededAt: new Date("2026-09-15T12:00:00Z") })
      .where(eq(schema.organizations.id, org.id));

    await seedDefaults(org.id, headers);

    const after = await roleNames();
    for (const policy of DEFAULT_TILL_POLICIES) {
      expect(after).toContain(policy.name);
    }
    const [kept] = await db
      .select({ permission: roles.permission })
      .from(roles)
      .where(tillRole("till supervisors"));
    expect(kept?.permission).toBe(theirs);
    const [group] = await db
      .select({ roles: schema.userGroups.roles })
      .from(schema.userGroups)
      .where(
        and(
          eq(schema.userGroups.organizationId, org.id),
          eq(schema.userGroups.name, "Till"),
        ),
      );
    expect(group?.roles).toEqual(["till"]);
    const [stamp] = await db
      .select({ at: schema.organizations.accessSeededAt })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
    expect((stamp?.at ?? new Date(0)) > new Date("2026-10-07T13:32:00Z")).toBe(
      true,
    );

    // Caught up once. Deleting one now is a decision, and it stays made.
    await db.delete(roles).where(tillRole("till"));
    await seedDefaults(org.id, headers);
    expect(await roleNames()).not.toContain("till");
  } finally {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
  }
});

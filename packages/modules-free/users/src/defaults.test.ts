import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GROUP_POLICIES, DEFAULT_USER_POLICIES } from "./defaults";
import { BUILT_IN } from "./roles";

const all = [...DEFAULT_USER_POLICIES, ...DEFAULT_GROUP_POLICIES];
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

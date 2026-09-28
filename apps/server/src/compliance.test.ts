import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { forgetHipaaRules } from "@sentrello/db/security-events";
import crm from "@sentrello/module-crm";
import { registerForTest } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";

/**
 * The HIPAA safeguards actually bite.
 *
 * A switch that turns on nothing is the defect this codebase keeps producing:
 * something built, described in the notes as done, and inert. It is worse here
 * than anywhere else in the platform, because a practice reads "HIPAA
 * safeguards" on a settings screen and believes a control exists.
 *
 * So each of the three is tested by doing the thing it is supposed to prevent.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(settings);
registerForTest(crm, app);

let headers: Headers;
let orgId: string;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `hipaa-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `HIPAA ${suffix}`, slug: `hipaa-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  const tidy = async (run: () => Promise<unknown>) => {
    await run().catch(() => {});
  };
  await tidy(() =>
    db
      .delete(schema.complianceSettings)
      .where(eq(schema.complianceSettings.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.contacts).where(eq(schema.contacts.organizationId, orgId)),
  );
  await tidy(() =>
    db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.member).where(eq(schema.member.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.organizations).where(eq(schema.organizations.id, orgId)),
  );
});

test("nothing applies until a business says it does", async () => {
  const { settings: s, regimes } = await json<{
    settings: { hipaa: boolean; regimes: string[] };
    regimes: { id: string; chosen: boolean }[];
  }>(await req("/api/compliance"));

  // A t-shirt shop in Texas carries none of this until it says otherwise.
  expect(s.regimes).toEqual([]);
  expect(s.hipaa).toBe(false);

  /*
   * And every regime is still listed. A business that starts selling into the
   * EU has to be able to find the thing it now needs; a screen showing only
   * what is already on cannot tell them it exists.
   */
  expect(regimes.length).toBeGreaterThan(3);
  expect(regimes.every((r) => !r.chosen)).toBe(true);
});

test("two questions suggest what is likely to apply, and say what is not", async () => {
  const shop = await json<{
    suggested: { id: string }[];
    notSuggested: { id: string; when: string }[];
  }>(
    await req("/api/compliance/suggest", {
      method: "POST",
      body: JSON.stringify({ places: ["us"], sectors: ["retail"] }),
    }),
  );
  // A US shop is not offered European paperwork.
  expect(shop.suggested.map((r) => r.id)).not.toContain("uk-eu-gdpr");

  const berlin = await json<{ suggested: { id: string }[] }>(
    await req("/api/compliance/suggest", {
      method: "POST",
      body: JSON.stringify({ places: ["eu"], sectors: ["retail"] }),
    }),
  );
  // The same shop in Berlin is.
  expect(berlin.suggested.map((r) => r.id)).toContain("uk-eu-gdpr");

  /*
   * And what was not suggested is still returned with its reason. A business
   * that reads "not suggested, because you are not in health" has learned
   * something; one that never sees it will not think of HIPAA when it takes on
   * its first medical client.
   */
  expect(shop.notSuggested.length).toBeGreaterThan(0);
  expect(shop.notSuggested.every((r) => r.when.length > 10)).toBe(true);
});

test("obligations shown are only the ones that follow from what was chosen", async () => {
  // Nothing chosen: nothing to do. A shop in Texas shown five HIPAA duties
  // learns to scroll past this panel, and then misses the one that did apply.
  const quiet = await json<{ yourOwnObligations: unknown[] }>(
    await req("/api/compliance"),
  );
  expect(quiet.yourOwnObligations).toEqual([]);

  await req("/api/compliance", {
    method: "PUT",
    body: JSON.stringify({ regimes: ["hipaa"], requireTwoFactor: false }),
  });

  const { yourOwnObligations } = await json<{
    yourOwnObligations: { what: string; why: string; regime: string }[];
  }>(await req("/api/compliance"));

  // A page that switches on three controls and says nothing about the rest
  // leaves a practice believing it is finished.
  expect(yourOwnObligations.length).toBeGreaterThanOrEqual(4);
  const all = yourOwnObligations.map((o) => o.what).join(" ");
  expect(all).toContain("risk assessment");
  expect(all).toContain("Business Associate");

  await req("/api/compliance", {
    method: "PUT",
    body: JSON.stringify({ regimes: [] }),
  });
});

test("an idle timeout longer than an hour is refused", async () => {
  const refused = await req("/api/compliance", {
    method: "PUT",
    body: JSON.stringify({ idleTimeoutMinutes: 480 }),
  });
  // "Automatic logoff after eight hours" satisfies a checklist and protects
  // nobody, which is the opposite of why the setting exists.
  expect(refused.status).toBe(400);
});

test("opening one person's record is logged once the safeguards are on", async () => {
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: `Patient ${suffix}` })
    .returning();
  if (!contact) throw new Error("no contact");

  // Off: nothing is recorded, because almost nobody wants this.
  await req(`/api/crm/history?contactId=${contact.id}`);
  const quiet = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  expect(quiet.filter((e) => e.action === "phi.read")).toHaveLength(0);

  /*
   * Without the two-factor rule, because this owner has no second factor and
   * the route refuses to lock them out — which the test below is about.
   */
  const enabled = await req("/api/compliance", {
    method: "PUT",
    body: JSON.stringify({
      regimes: ["hipaa"],
      logReads: true,
      requireTwoFactor: false,
    }),
  });
  expect(enabled.status).toBe(200);
  forgetHipaaRules(orgId);

  await req(`/api/crm/history?contactId=${contact.id}`);

  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  const reads = events.filter((e) => e.action === "phi.read");
  expect(reads).toHaveLength(1);
  // Who looked, which is the entire question after a snooping incident.
  expect(reads[0]?.actorName).toBeTruthy();
});

/**
 * Switching this on must not lock the person switching it on out of their own
 * instance.
 *
 * Requiring a second factor from everybody is correct, and it is also a door
 * that closes behind you: an administrator who turns it on without having set
 * one up is refused by every route in the product — including the one that
 * would turn it off. That is what happened the first time this was tested, and
 * it is the same mistake as closing a firewall port from the far side of the
 * firewall.
 *
 * Two defences, and both are tested because either alone is not enough.
 */
test("the two-factor rule will not lock out the person enabling it", async () => {
  const refused = await req("/api/compliance", {
    method: "PUT",
    body: JSON.stringify({ requireTwoFactor: true }),
  });
  expect(refused.status).toBe(400);
  const { error } = await json<{ error: string }>(refused);
  // The message has to say what to do. A bare "forbidden" on the click that
  // caused it is how somebody decides the safeguards are broken.
  expect(error).toContain("second factor");
});

test("the compliance screen stays reachable even when everything else is not", async () => {
  // Forced past the refusal above, the way a database edit or an older release
  // could leave an instance: the rule on, and nobody holding a second factor.
  await db
    .update(schema.complianceSettings)
    .set({ hipaa: true, requireTwoFactor: true })
    .where(eq(schema.complianceSettings.organizationId, orgId));
  forgetHipaaRules(orgId);

  // Everything else is refused, which is the safeguard working.
  const shut = await req("/api/contacts");
  expect(shut.status).toBe(403);

  // And the way back is open, which is what stops it being a trap.
  const back = await req("/api/compliance");
  expect(back.status).toBe(200);

  await db
    .update(schema.complianceSettings)
    .set({ requireTwoFactor: false })
    .where(eq(schema.complianceSettings.organizationId, orgId));
  forgetHipaaRules(orgId);
});

test("turning the safeguards off is itself recorded", async () => {
  await req("/api/compliance", {
    method: "PUT",
    body: JSON.stringify({ regimes: [] }),
  });

  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));

  // Either a business that stopped being a covered entity, or somebody trying
  // to make an audit trail stop. The second is the reason this line exists.
  expect(events.map((e) => e.action)).toContain("hipaa.disabled");
});

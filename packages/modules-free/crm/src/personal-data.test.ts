import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import { personalDataSources, registerForTest } from "@sentrello/module-sdk";
import crm from "./index";

/**
 * What a subject access request actually returns about a contact.
 *
 * The published compliance page says the "do not sell or share" opt-out is
 * recorded with the date it was received and carried into every contact
 * export. It was recorded, and then left out of both places the record leaves
 * the product: the CSV carried the flag without the date, and the answer to a
 * subject access request — the one document that has to contain everything —
 * carried neither.
 *
 * "When did I tell you not to sell my data" is exactly what this request is
 * for.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const slug = `crm-sar-${suffix}`;
let orgId: string;

afterAll(async () => {
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId))
    .catch(() => {});
  await dropOrganization(slug).catch(() => {});
});

test("a subject access request carries the opt-out and its date", async () => {
  orgId = await makeOrganization(slug);

  const recordedOn = new Date("2026-03-04T09:15:00Z");
  await db.insert(schema.contacts).values({
    organizationId: orgId,
    name: `Opted Out ${suffix}`,
    email: `sar-${suffix}@example.test`,
    doNotSell: true,
    doNotSellOn: recordedOn,
  });

  /*
   * The contributor as the platform sees it. Registering the module and then
   * asking the registry what it registered is the only way to test the thing
   * that actually answers a request — a copy of the query here would pass
   * while the real one stayed wrong.
   */
  registerForTest(crm);
  const contributor = personalDataSources().find((s) => s.id === "crm");
  if (!contributor) throw new Error("the CRM registered no personal data");

  const records = await contributor.export(orgId, {
    email: `sar-${suffix}@example.test`,
  });
  const contact = records.find((r) => r.kind === "Contact");
  expect(contact).toBeTruthy();
  expect(contact?.data.doNotSell).toBe(true);
  expect(contact?.data.doNotSellOn).toEqual(recordedOn);
});

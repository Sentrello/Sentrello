import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { recordChanged } from "@sentrello/db/record-events";
import { record } from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Two records for one person, found and folded together.
 *
 * Detection is suggestive, never automatic: it proposes pairs and a person
 * confirms, because a wrong automatic merge is very hard to undo and the
 * false positives are certain — a shared office landline, a father and son
 * with one email between them. The expensive half is the merge itself: a
 * contact is named by notes, tasks, activities, deals, quotes, invoices,
 * recurring profiles, bank rows and tax details, and every one of them has
 * to follow the kept record or the business is left with an invoice that
 * names nobody. Everything moves in one transaction, and what happened is
 * written down — the folded-in row whole — because the merge deletes the
 * only other place that could say.
 */

/** The last ten digits, which is what two spellings of one number share. */
function phoneKey(raw: string | null): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

/** The two ids as one stable pair, lower uuid first. */
function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

interface Candidate {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  createdAt: Date;
}

/** Every pair sharing an email, a phone or a whole name, best reason first. */
export function findDuplicates(
  contacts: Candidate[],
): { a: Candidate; b: Candidate; reason: string }[] {
  const byKey = new Map<string, Candidate[]>();
  const put = (key: string | null, contact: Candidate) => {
    if (!key) return;
    const list = byKey.get(key) ?? [];
    list.push(contact);
    byKey.set(key, list);
  };
  for (const contact of contacts) {
    const email = contact.email?.trim().toLowerCase();
    put(email ? `e:${email}` : null, contact);
    const phone = phoneKey(contact.phone);
    put(phone ? `p:${phone}` : null, contact);
    const name = contact.name?.trim().toLowerCase();
    put(name ? `n:${name}` : null, contact);
  }

  const reasons: Record<string, string> = {
    e: "same email",
    p: "same phone",
    n: "same name",
  };
  // Email first, then phone, then name, so a pair matching twice carries
  // the stronger reason.
  const found = new Map<
    string,
    { a: Candidate; b: Candidate; reason: string }
  >();
  for (const prefix of ["e", "p", "n"]) {
    for (const [key, group] of byKey) {
      if (!key.startsWith(`${prefix}:`) || group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (!a || !b) continue;
          const pair = pairKey(a.id, b.id).join("/");
          if (!found.has(pair)) {
            found.set(pair, { a, b, reason: reasons[prefix] ?? "" });
          }
        }
      }
    }
  }
  return [...found.values()];
}

export function registerMerge(ctx: ModuleContext) {
  /**
   * Likely duplicates, proposed.
   *
   * Read whole and matched in memory: grouping by three keys over one pass
   * is linear, and a business under twenty staff does not have the book
   * that makes this a query problem.
   */
  ctx.app.get(
    "/api/contacts/duplicates",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [contacts, dismissals] = await Promise.all([
        db
          .select({
            id: schema.contacts.id,
            name: schema.contacts.name,
            email: schema.contacts.email,
            phone: schema.contacts.phone,
            createdAt: schema.contacts.createdAt,
          })
          .from(schema.contacts)
          .where(eq(schema.contacts.organizationId, orgId)),
        db
          .select()
          .from(schema.contactDuplicateDismissals)
          .where(eq(schema.contactDuplicateDismissals.organizationId, orgId)),
      ]);

      const dismissed = new Set(
        dismissals.map((d) => `${d.firstId}/${d.secondId}`),
      );
      const pairs = findDuplicates(contacts)
        .filter((p) => !dismissed.has(pairKey(p.a.id, p.b.id).join("/")))
        .slice(0, 50);
      return c.json({ pairs });
    },
  );

  /** "Two different people" — said once, remembered." */
  ctx.app.post(
    "/api/contacts/duplicates/dismiss",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        aId?: string;
        bId?: string;
      };
      const aId = String(body.aId ?? "");
      const bId = String(body.bId ?? "");
      if (!aId || !bId || aId === bId) {
        return c.json({ error: "two different contacts are required" }, 400);
      }
      // Both this organization's, or a guessed id could park dismissals
      // against somebody else's book.
      const owned = await db
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.organizationId, orgId),
            inArray(schema.contacts.id, [aId, bId]),
          ),
        );
      if (owned.length !== 2) return c.json({ error: "no such contact" }, 404);

      const [firstId, secondId] = pairKey(aId, bId);
      await db
        .insert(schema.contactDuplicateDismissals)
        .values({ organizationId: orgId, firstId, secondId })
        .onConflictDoNothing();
      return c.json({ ok: true });
    },
  );

  /**
   * Fold one contact into another, deliberately.
   *
   * `:id` is the record kept; the body names the one folded in. One
   * transaction: either everything follows the kept record — money included
   * — or nothing moved at all. The ledger is untouched by construction:
   * journal entries name accounts, not contacts, and re-pointing an
   * invoice's `contactId` changes who it addresses, never what it posted.
   */
  ctx.app.post(
    "/api/contacts/:id/merge",
    requireSession(),
    requirePermission({ crm: ["update", "delete"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const keptId = c.req.param("id") ?? "";
      const body = (await c.req.json().catch(() => ({}))) as {
        mergedId?: string;
      };
      const mergedId = String(body.mergedId ?? "");
      if (!mergedId || mergedId === keptId) {
        return c.json(
          { error: "a different contact to fold in is required" },
          400,
        );
      }

      const rows = await db
        .select()
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.organizationId, orgId),
            inArray(schema.contacts.id, [keptId, mergedId]),
          ),
        );
      const kept = rows.find((r) => r.id === keptId);
      const merged = rows.find((r) => r.id === mergedId);
      if (!kept || !merged) return c.json({ error: "not found" }, 404);

      /*
       * Contractor tax details are unique per contact and carry a TIN. Two
       * rows cannot become one by a rule — somebody who knows which number
       * is right has to delete the wrong one first — so this refuses whole
       * rather than guessing about tax identity.
       */
      const taxRows = await db
        .select({ contactId: schema.contractorTaxDetails.contactId })
        .from(schema.contractorTaxDetails)
        .where(
          and(
            eq(schema.contractorTaxDetails.organizationId, orgId),
            inArray(schema.contractorTaxDetails.contactId, [keptId, mergedId]),
          ),
        );
      if (taxRows.length === 2) {
        return c.json(
          {
            error:
              "both contacts hold contractor tax details; remove the wrong one first, then merge",
          },
          409,
        );
      }

      const moved: Record<string, number> = {};
      const updatedKept = await db.transaction(async (tx) => {
        /** Re-point one column of one table, and count what moved. */
        const repoint = async (
          label: string,
          table:
            | typeof schema.tasks
            | typeof schema.activities
            | typeof schema.quotes
            | typeof schema.invoices
            | typeof schema.recurringProfiles
            | typeof schema.transactions
            | typeof schema.payees
            | typeof schema.formSubmissions
            | typeof schema.contractorTaxDetails,
        ) => {
          const changed = await tx
            .update(table)
            .set({ contactId: keptId })
            .where(
              and(
                eq(table.organizationId, orgId),
                eq(table.contactId, mergedId),
              ),
            )
            .returning({ id: table.id });
          if (changed.length) moved[label] = changed.length;
        };

        await repoint("tasks", schema.tasks);
        await repoint("activities", schema.activities);
        await repoint("quotes", schema.quotes);
        await repoint("invoices", schema.invoices);
        await repoint("recurringProfiles", schema.recurringProfiles);
        await repoint("transactions", schema.transactions);
        await repoint("payees", schema.payees);
        await repoint("formSubmissions", schema.formSubmissions);
        await repoint("contractorTaxDetails", schema.contractorTaxDetails);

        const notes = await tx
          .update(schema.notes)
          .set({ entityId: keptId })
          .where(
            and(
              eq(schema.notes.organizationId, orgId),
              eq(schema.notes.entityType, "contact"),
              eq(schema.notes.entityId, mergedId),
            ),
          )
          .returning({ id: schema.notes.id });
        if (notes.length) moved.notes = notes.length;

        /*
         * Tags: keep the union. A label the kept contact already carries is
         * dropped rather than doubled; the rest follow. Scoped through the
         * tag's organization, the same rule every taggables query follows.
         */
        const [keptTags, mergedTags] = await Promise.all([
          tx
            .select({ tagId: schema.taggables.tagId })
            .from(schema.taggables)
            .innerJoin(schema.tags, eq(schema.tags.id, schema.taggables.tagId))
            .where(
              and(
                eq(schema.tags.organizationId, orgId),
                eq(schema.taggables.entityType, "contact"),
                eq(schema.taggables.entityId, keptId),
              ),
            ),
          tx
            .select({ tagId: schema.taggables.tagId })
            .from(schema.taggables)
            .innerJoin(schema.tags, eq(schema.tags.id, schema.taggables.tagId))
            .where(
              and(
                eq(schema.tags.organizationId, orgId),
                eq(schema.taggables.entityType, "contact"),
                eq(schema.taggables.entityId, mergedId),
              ),
            ),
        ]);
        const already = new Set(keptTags.map((t) => t.tagId));
        let movedTags = 0;
        for (const { tagId } of mergedTags) {
          if (already.has(tagId)) {
            await tx
              .delete(schema.taggables)
              .where(
                and(
                  eq(schema.taggables.tagId, tagId),
                  eq(schema.taggables.entityType, "contact"),
                  eq(schema.taggables.entityId, mergedId),
                ),
              );
          } else {
            await tx
              .update(schema.taggables)
              .set({ entityId: keptId })
              .where(
                and(
                  eq(schema.taggables.tagId, tagId),
                  eq(schema.taggables.entityType, "contact"),
                  eq(schema.taggables.entityId, mergedId),
                ),
              );
            movedTags += 1;
          }
        }
        if (movedTags) moved.tags = movedTags;

        // Deals hold their people in a jsonb array, so each is rewritten
        // with the folded-in id replaced and the result deduplicated — a
        // deal both were on must not list the kept contact twice.
        const onDeals = await tx
          .select()
          .from(schema.deals)
          .where(
            and(
              eq(schema.deals.organizationId, orgId),
              sql`${schema.deals.contactIds} @> ${JSON.stringify([mergedId])}::jsonb`,
            ),
          );
        for (const deal of onDeals) {
          const next = [
            ...new Set(
              (deal.contactIds ?? []).map((id) =>
                id === mergedId ? keptId : id,
              ),
            ),
          ];
          await tx
            .update(schema.deals)
            .set({ contactIds: next })
            .where(eq(schema.deals.id, deal.id));
        }
        if (onDeals.length) moved.deals = onDeals.length;

        /*
         * The kept record drinks in what it was missing — a field the kept
         * row already has always wins, because keeping is the choice the
         * person just made. The two legal positions are different: "do not
         * sell" is a refusal either of them made, so the stricter answer
         * survives, from the earlier date; newsletter consent held by
         * either is consent the person gave, and its evidence rows still
         * name the id the merge record maps back to this one.
         */
        const fill: Record<string, unknown> = {};
        for (const field of [
          "email",
          "phone",
          "title",
          "companyId",
          "linkedinUrl",
          "background",
          "avatarPath",
          "gender",
          "ownerId",
        ] as const) {
          if (!kept[field] && merged[field]) fill[field] = merged[field];
        }
        if (!kept.firstName && !kept.lastName && merged.firstName) {
          fill.firstName = merged.firstName;
          fill.lastName = merged.lastName;
        }
        // A second address or number that differs is kept as a labelled
        // extra rather than lost with the row that carried it.
        if (kept.email && merged.email && kept.email !== merged.email) {
          fill.emails = [
            ...(kept.emails ?? []),
            { label: "merged", value: merged.email },
          ];
        }
        if (kept.phone && merged.phone && kept.phone !== merged.phone) {
          fill.phones = [
            ...(kept.phones ?? []),
            { label: "merged", value: merged.phone },
          ];
        }
        if (merged.doNotSell && !kept.doNotSell) {
          fill.doNotSell = true;
          fill.doNotSellOn = merged.doNotSellOn ?? new Date();
        }
        if (merged.hasNewsletter && !kept.hasNewsletter) {
          fill.hasNewsletter = true;
        }
        if (
          merged.firstSeenAt &&
          (!kept.firstSeenAt || merged.firstSeenAt < kept.firstSeenAt)
        ) {
          fill.firstSeenAt = merged.firstSeenAt;
        }
        if (
          merged.lastSeenAt &&
          (!kept.lastSeenAt || merged.lastSeenAt > kept.lastSeenAt)
        ) {
          fill.lastSeenAt = merged.lastSeenAt;
        }

        const [updated] = Object.keys(fill).length
          ? await tx
              .update(schema.contacts)
              .set(fill)
              .where(
                and(
                  eq(schema.contacts.id, keptId),
                  eq(schema.contacts.organizationId, orgId),
                ),
              )
              .returning()
          : [kept];

        await tx
          .delete(schema.contacts)
          .where(
            and(
              eq(schema.contacts.id, mergedId),
              eq(schema.contacts.organizationId, orgId),
            ),
          );

        // The one place that can still say what the folded-in record was.
        await tx.insert(schema.contactMerges).values({
          organizationId: orgId,
          keptId,
          mergedId,
          mergedRecord: merged as unknown as Record<string, unknown>,
          moved,
          actorId: session.user.id,
        });

        return updated ?? kept;
      });

      // Announced like any other write, so an automation or a webhook
      // learns the folded-in record is gone and the kept one changed.
      await recordChanged({
        organizationId: orgId,
        entity: "contact",
        entityId: mergedId,
        action: "deleted",
        before: merged as unknown as Record<string, unknown>,
        after: null,
      });
      await recordChanged({
        organizationId: orgId,
        entity: "contact",
        entityId: keptId,
        action: "updated",
        before: kept as unknown as Record<string, unknown>,
        after: updatedKept as unknown as Record<string, unknown>,
      });
      await record({
        organizationId: orgId,
        actor: session.user,
        action: "crm.contacts.merged",
        subject: { id: mergedId, name: merged.name },
        detail: { keptId, mergedId, moved },
      });

      return c.json({ contact: updatedKept, moved });
    },
  );
}

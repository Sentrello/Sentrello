import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, desc, eq, schema } from "@sentrello/db";
import { record as recordSecurityEvent } from "@sentrello/db/security-events";
import type {
  DataSubject,
  ModuleContext,
  RouteContext,
} from "@sentrello/module-sdk";
import { personalDataSources } from "@sentrello/module-sdk";

/**
 * One place to answer a person asking about their own data.
 *
 * GDPR gives someone a month to be told what is held about them (article 15),
 * to have it in a portable form (20), to have it corrected (16) and to have it
 * erased (17). The CCPA gives Californians the rights to know, to delete, and
 * to opt out of their data being sold or shared, with 45 days to answer. The
 * deadlines are the reason this is a screen rather than a runbook: a business
 * of nine people will not meet a month by hand across six modules.
 *
 * The platform could not answer either question before this. The Shop module
 * had its own export and erase, the Links module could forget an address, and
 * everything else — the CRM above all, where a contact record *is* a person —
 * had nothing. A person does not know the Shop module from the CRM, and asks
 * once.
 *
 * Every module that holds personal data registers what it holds. This runs
 * whatever this instance loaded, so a module that is not installed contributes
 * nothing, which is the right answer rather than a gap.
 *
 * **What this cannot do, and does not pretend to.** It cannot decide whether a
 * request is genuine — verifying that the person asking is the person named is
 * the business's job, and the note recorded with each request is where they say
 * how they did it. It cannot rule on whether an exemption applies. It gathers
 * the facts and does what it is told, and it writes down that it happened.
 */
export function registerPrivacy(ctx: ModuleContext) {
  const subjectFrom = (body: Record<string, unknown>): DataSubject => ({
    email: typeof body.email === "string" ? body.email.trim() : undefined,
    phone: typeof body.phone === "string" ? body.phone.trim() : undefined,
    address: typeof body.address === "string" ? body.address.trim() : undefined,
    id: typeof body.subjectId === "string" ? body.subjectId : undefined,
  });

  const named = (subject: DataSubject) =>
    subject.email ?? subject.phone ?? subject.address ?? subject.id ?? "";

  /**
   * What every loaded module says it holds, and for how long.
   *
   * This *is* the record of processing a business is asked for when somebody
   * official comes calling — assembled from the modules that are actually
   * installed rather than from a document somebody wrote once and stopped
   * updating.
   */
  ctx.app.get(
    "/api/privacy/sources",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) =>
      c.json({
        sources: personalDataSources().map((s) => ({
          id: s.id,
          module: s.moduleId,
          label: s.label,
          retention: s.retention,
          canErase: Boolean(s.erase),
        })),
      }),
  );

  /**
   * Everything held about one person, from every module at once.
   *
   * A module that throws is reported as having failed rather than being left
   * out silently: an export missing a module's records is a legal answer that
   * is wrong, and the business needs to know which part did not answer.
   */
  ctx.app.post(
    "/api/privacy/export",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const subject = subjectFrom(body);
      if (!named(subject)) {
        return c.json(
          { error: "who is asking? give an email or a phone" },
          400,
        );
      }

      const found: {
        source: string;
        label: string;
        records: unknown[];
        error?: string;
      }[] = [];

      for (const source of personalDataSources()) {
        try {
          const records = await source.export(orgId, subject);
          found.push({ source: source.id, label: source.label, records });
        } catch (err) {
          found.push({
            source: source.id,
            label: source.label,
            records: [],
            error: (err as Error).message,
          });
        }
      }

      const session = c.get("session");
      await recordSecurityEvent({
        organizationId: orgId,
        actor: { id: session?.user?.id ?? "", name: session?.user?.name },
        subject: { email: subject.email ?? null, name: named(subject) },
        action: "privacy.exported",
        detail: { records: found.reduce((n, f) => n + f.records.length, 0) },
      });

      return c.json({
        subject: named(subject),
        answeredAt: new Date().toISOString(),
        sources: found,
        total: found.reduce((n, f) => n + f.records.length, 0),
      });
    },
  );

  /**
   * Erasure, across every module that can do it.
   *
   * Runs even where one module fails, and reports both: a half-finished
   * erasure that says nothing is worse than one that says which half.
   */
  ctx.app.post(
    "/api/privacy/erase",
    requireSession(),
    requirePermission({ settings: ["write"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const subject = subjectFrom(body);
      if (!named(subject)) {
        return c.json(
          { error: "who is asking? give an email or a phone" },
          400,
        );
      }
      /**
       * A note about how the request was verified, required.
       *
       * Erasure is irreversible and the commonest way it goes wrong is
       * somebody being talked into deleting the wrong person's record. Making
       * the business write down how they checked is the cheapest control there
       * is, and it is the thing a regulator asks for afterwards.
       */
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!note) {
        return c.json(
          { error: "say how you checked this is really them" },
          400,
        );
      }

      const done: {
        source: string;
        label: string;
        removed: string[];
        kept: { what: string; why: string }[];
        error?: string;
      }[] = [];

      for (const source of personalDataSources()) {
        if (!source.erase) {
          done.push({
            source: source.id,
            label: source.label,
            removed: [],
            kept: [{ what: source.label, why: source.retention }],
          });
          continue;
        }
        try {
          const outcome = await source.erase(orgId, subject);
          done.push({ source: source.id, label: source.label, ...outcome });
        } catch (err) {
          done.push({
            source: source.id,
            label: source.label,
            removed: [],
            kept: [],
            error: (err as Error).message,
          });
        }
      }

      const session = c.get("session");
      await recordSecurityEvent({
        organizationId: orgId,
        actor: { id: session?.user?.id ?? "", name: session?.user?.name },
        subject: { email: subject.email ?? null, name: named(subject) },
        action: "privacy.erased",
        // How they checked it was really them, kept with the act itself. This
        // is the line a regulator asks about afterwards.
        detail: { verifiedBy: note },
      });

      return c.json({ subject: named(subject), sources: done });
    },
  );

  /**
   * What was asked and what was done, which is the part a regulator wants.
   *
   * Kept in the security log rather than a table of its own: it is the same
   * kind of fact — somebody did something consequential, here is when and who —
   * and a second audit trail is a second thing to forget to read.
   */
  ctx.app.get(
    "/api/privacy/requests",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.securityEvents)
        .where(eq(schema.securityEvents.organizationId, orgId))
        .orderBy(desc(schema.securityEvents.at))
        .limit(500);
      return c.json({
        requests: rows.filter((r) => r.action.startsWith("privacy.")),
      });
    },
  );
}

import { randomBytes } from "node:crypto";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, asc, db, eq, lt, schema, sql } from "@sentrello/db";
import { creditFor } from "@sentrello/db/credit";
import { contactHasEmail } from "@sentrello/db/crm";
import { lineTotals } from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import { emailAdapter, systemFrom } from "@sentrello/email";
import type { ModuleContext } from "@sentrello/module-sdk";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentFile,
  attachmentHeaders,
  checkUpload,
  csvDownload,
  displayFilename,
  removeAttachment,
  scannerAddress,
  storeAttachment,
  toCsv,
} from "@sentrello/module-sdk";
import {
  HONEYPOT_FIELD,
  corsHeaders,
  looksAutomated,
  normalizeOrigin,
  originAllowed,
  rateLimit,
} from "@sentrello/module-sdk";
import { embedScript } from "./forms-loader";
import { html, problemPage, thanksPage, wantsHtml } from "./forms-reply";

/** Per-form limit for public submissions. Generous for humans, hostile to bots. */
const SUBMIT_LIMIT = 5;
const SUBMIT_WINDOW_MS = 60_000;

const KIND = ["contact", "quote"] as const;

function newFormKey(): string {
  return `frm_${randomBytes(12).toString("base64url")}`;
}

/** More sites than any small business embeds a single form on. */
const MAX_ORIGINS = 50;

/**
 * The sites a form may be embedded on, as the check will compare them.
 *
 * Throws rather than dropping a bad entry: somebody who typed one wrong needs
 * to be told, because the failure they would otherwise meet is their own site
 * showing nothing at all.
 */
function cleanOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new RangeError("allowed sites must be a list");
  }
  if (value.length > MAX_ORIGINS) {
    throw new RangeError(`a form can list at most ${MAX_ORIGINS} sites`);
  }

  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new RangeError("that is not a site");
    if (!entry.trim()) continue;
    const host = normalizeOrigin(entry);
    if (!host) {
      throw new RangeError(
        `"${entry.trim().slice(0, 60)}" is not a site. Use example.com, https://example.com or *.example.com`,
      );
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * Forms: the website end of the CRM.
 *
 * A form somebody embeds on their own site, and every submission arriving as a
 * CRM contact with the enquiry attached. It lived in its own module until the
 * shape of the thing became clear — it has no data of its own, no permissions
 * of its own, and nothing it produces means anything outside the CRM. A module
 * that cannot be switched off independently is a feature, so it is one now.
 */
/**
 * How long a file sent through a public form is kept.
 *
 * A year, then it goes. These are other people's documents — a CV, a scanned
 * invoice, a photograph of somebody's meter — sent to a business by a
 * stranger, and keeping them forever is a decision nobody made. The
 * submission stays: it is the record of the enquiry, and it is what the
 * business answered. Only the file leaves.
 *
 * Set `SENTRELLO_FORM_UPLOAD_DAYS` to something else where the law or the
 * business says something else. Zero turns the sweep off, which is a choice
 * an instance is allowed to make and must make deliberately.
 */
export function uploadRetentionDays(): number {
  const set = Number(process.env.SENTRELLO_FORM_UPLOAD_DAYS ?? 365);
  return Number.isFinite(set) && set >= 0 ? set : 365;
}

/**
 * Throws away the files that have aged out, and says how many.
 *
 * The row keeps its shape — `attachments` becomes an empty list rather than
 * disappearing — so a submission that once had a file still reads as one that
 * had a file, and nobody goes looking for a bug.
 */
export async function sweepExpiredUploads(now = new Date()): Promise<number> {
  const days = uploadRetentionDays();
  if (days === 0) return 0;

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: schema.formSubmissions.id,
      attachments: schema.formSubmissions.attachments,
    })
    .from(schema.formSubmissions)
    .where(
      and(
        lt(schema.formSubmissions.createdAt, cutoff),
        sql`jsonb_array_length(${schema.formSubmissions.attachments}) > 0`,
      ),
    )
    .limit(500);

  let gone = 0;
  for (const row of rows) {
    for (const held of row.attachments ?? []) {
      await removeAttachment(held.path, UPLOAD_FOLDER);
      gone += 1;
    }
    await db
      .update(schema.formSubmissions)
      .set({ attachments: [] })
      .where(eq(schema.formSubmissions.id, row.id));
  }
  return gone;
}

export function registerForms(ctx: ModuleContext) {
  // Once a night. Nothing here is urgent, and a sweep that runs while
  // somebody is filling in a form is a sweep competing for the same disk.
  ctx.registerJob({
    name: "form-uploads-retention",
    cron: "17 3 * * *",
    handler: () => sweepExpiredUploads(),
  });

  ctx.registerNav({
    id: "forms",
    icon: "clipboard",
    label: "Forms",
    // Under CRM, above Settings. It is where the CRM's records come from, so
    // it sits with the screens that show them — Settings is configuration and
    // belongs last.
    order: 4.5,
    parent: "crm",
    // Forms feed the CRM, and its routes are guarded by the CRM's own
    // permissions — so the menu follows the same rule.
    requires: { crm: ["update"] },
  });

  // --- management (authenticated) ---

  ctx.app.get(
    "/api/forms",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.forms)
        .where(eq(schema.forms.organizationId, orgId));

      /**
       * How many have come in, per form.
       *
       * One grouped query rather than one per row. Without it the list said
       * nothing about whether a form was working — which is the only
       * question anybody has about an embed on somebody else's website.
       */
      const counts = await db
        .select({
          formId: schema.formSubmissions.formId,
          total: sql<number>`count(*)::int`,
        })
        .from(schema.formSubmissions)
        .where(eq(schema.formSubmissions.organizationId, orgId))
        .groupBy(schema.formSubmissions.formId);
      const seen = new Map(counts.map((c) => [c.formId, c.total]));

      return c.json({
        forms: rows.map((form) => ({
          ...form,
          submissionCount: seen.get(form.id) ?? 0,
        })),
      });
    },
  );

  ctx.app.post(
    "/api/forms",
    requireSession(),
    requirePermission({ crm: ["create"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      if (body.kind && !KIND.includes(body.kind)) {
        return c.json({ error: `kind must be one of ${KIND.join("|")}` }, 400);
      }
      let allowedOrigins: string[];
      try {
        allowedOrigins = cleanOrigins(body.allowedOrigins ?? []);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      const [row] = await db
        .insert(schema.forms)
        .values({
          organizationId: orgId,
          key: newFormKey(),
          name: body.name ?? "Contact form",
          kind: body.kind ?? "contact",
          allowedOrigins,
          fields: body.fields ?? defaultFields(body.kind ?? "contact"),
          redirectUrl: body.redirectUrl,
          notifyEmail: body.notifyEmail,
        })
        .returning();
      return c.json({ form: row }, 201);
    },
  );

  ctx.app.patch(
    "/api/forms/:id",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();

      /**
       * What may be changed, named rather than inferred.
       *
       * This spread the whole body into the SET clause with three fields
       * picked back out — which covers the three somebody thought of, and
       * nothing added to the table since. `createdAt` was writable, and so
       * would be any column added tomorrow by anybody not reading this
       * route.
       */
      const patch: Record<string, unknown> = {};
      for (const field of [
        "name",
        "kind",
        "tag",
        "style",
        "allowedOrigins",
        "fields",
        "redirectUrl",
        "notifyEmail",
        "active",
      ] as const) {
        if (body[field] !== undefined) patch[field] = body[field];
      }

      // The one field on a form that decides whether it works at all, so it
      // is cleaned here as well as on the screen: a form is also editable by
      // anything holding a session, not only by our own page.
      if ("allowedOrigins" in patch) {
        try {
          patch.allowedOrigins = cleanOrigins(patch.allowedOrigins);
        } catch (err) {
          return c.json({ error: (err as Error).message }, 400);
        }
      }

      const [row] = await db
        .update(schema.forms)
        .set(patch)
        .where(
          and(
            eq(schema.forms.id, c.req.param("id")),
            eq(schema.forms.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ form: row });
    },
  );

  /**
   * Taking a form down.
   *
   * Its submissions go with it — they are answers to questions that no
   * longer exist, and keeping them would leave rows nobody can read. Anyone
   * who was promoted to a contact stays in the CRM, which is the part a
   * business would actually miss.
   */
  ctx.app.delete(
    "/api/forms/:id",
    requireSession(),
    requirePermission({ crm: ["delete"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [mine] = await db
        .select({ id: schema.forms.id })
        .from(schema.forms)
        .where(
          and(eq(schema.forms.id, id), eq(schema.forms.organizationId, orgId)),
        )
        .limit(1);
      if (!mine) return c.json({ error: "not found" }, 404);

      await db
        .delete(schema.formSubmissions)
        .where(
          and(
            eq(schema.formSubmissions.formId, id),
            eq(schema.formSubmissions.organizationId, orgId),
          ),
        );
      await db
        .delete(schema.forms)
        .where(
          and(eq(schema.forms.id, id), eq(schema.forms.organizationId, orgId)),
        );
      return c.json({ ok: true });
    },
  );

  ctx.app.get(
    "/api/forms/:id/submissions",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.formSubmissions)
        .where(
          and(
            eq(schema.formSubmissions.formId, c.req.param("id")),
            eq(schema.formSubmissions.organizationId, orgId),
          ),
        );
      return c.json({ submissions: rows });
    },
  );

  /**
   * The file somebody attached, handed back to whoever may read the form.
   *
   * The path is read off the row rather than taken from the request, so
   * there is nothing here to point at another organization's folder — and the
   * SDK checks it against the uploads directory anyway, because a row is data
   * and data that was edited once can be edited again. It comes back as a
   * download with a neutral content type: a file that arrived from the open
   * internet must never be served as something this origin will run.
   */
  ctx.app.get(
    "/api/forms/submissions/:submissionId/files/:index",
    /*
     * A refusal a person can act on.
     *
     * This link is in an email. Somebody reads "a new enquiry", clicks the
     * CV, and — if they are not signed in on that device, which is most
     * devices — the guard behind it answers `{"error":"unauthorized"}` in the
     * browser window. That is a dead end: it does not say whether to sign in,
     * whether the file is gone, or whether the thing is broken.
     *
     * The guard is right and stays exactly as it is. This only rewrites what
     * a browser is shown, and only when the answer was a refusal.
     */
    async (c, next) => {
      await next();
      if ((c.res.status === 401 || c.res.status === 403) && wantsHtml(c)) {
        c.res = new Response(
          problemPage(
            "You need to be signed in to open this file. Sign in, then follow the link again.",
          ),
          {
            status: c.res.status,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
    },
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .select()
        .from(schema.formSubmissions)
        .where(
          and(
            eq(schema.formSubmissions.id, c.req.param("submissionId")),
            eq(schema.formSubmissions.organizationId, orgId),
          ),
        )
        .limit(1);
      const at = Number(c.req.param("index"));
      const held = row?.attachments?.[Number.isFinite(at) ? at : -1];
      if (!held) return c.json({ error: "not found" }, 404);

      const file = attachmentFile(held.path, UPLOAD_FOLDER);
      if (!file || !(await file.exists())) {
        return c.json({ error: "not found" }, 404);
      }
      return new Response(file.stream(), {
        headers: attachmentHeaders(held.name),
      });
    },
  );

  /**
   * The same submissions as a spreadsheet.
   *
   * The columns come from the **form's own field list**, not from the keys
   * of whichever row happens to be first. A form that gained a question last
   * week has older submissions with nothing under it, and deriving headers
   * from row one would drop that column entirely — or worse, shift every
   * value in the rows that do have it one place to the left.
   *
   * A field that was later deleted from the form still has answers sitting
   * in old submissions, so anything the payload holds that the form no
   * longer asks is appended after the known columns rather than discarded.
   * An export that silently loses what somebody typed is not an export.
   */
  ctx.app.get(
    "/api/forms/:id/submissions.csv",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const formId = c.req.param("id");

      const [form] = await db
        .select()
        .from(schema.forms)
        .where(
          and(
            eq(schema.forms.id, formId),
            eq(schema.forms.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!form) return c.json({ error: "not found" }, 404);

      const rows = await db
        .select()
        .from(schema.formSubmissions)
        .where(
          and(
            eq(schema.formSubmissions.formId, formId),
            eq(schema.formSubmissions.organizationId, orgId),
          ),
        )
        .orderBy(asc(schema.formSubmissions.createdAt));

      const defined = (form.fields ?? []) as {
        name: string;
        label?: string;
      }[];
      const keys = defined.map((f) => f.name);
      const labels = defined.map((f) => f.label || f.name);

      for (const row of rows) {
        for (const key of Object.keys(row.payload ?? {})) {
          if (!keys.includes(key)) {
            keys.push(key);
            labels.push(key);
          }
        }
      }

      const csv = toCsv(
        ["Received", ...labels],
        rows.map((row) => [
          row.createdAt.toISOString(),
          ...keys.map((key) => row.payload?.[key] ?? ""),
        ]),
      );

      const safe = (form.name || "submissions")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return c.body(csv, 200, csvDownload(`${safe || "submissions"}.csv`));
    },
  );

  // --- public embed endpoints (no session, by design) ---

  /** Preflight for cross-site posts. */
  /**
   * The forms a business would otherwise have to invent.
   *
   * A new instance opens the Forms screen to nothing at all and has to guess
   * what a form is for and which fields belong on it. These are the two
   * every small business needs — somebody asking a question, and somebody
   * asking what a job would cost.
   *
   * Offered as a button in the empty state rather than created silently at
   * first run: a business that has deliberately deleted its forms should not
   * find them back tomorrow, and a screen that fills itself is harder to
   * understand than one that asks.
   */
  ctx.app.post(
    "/api/forms/defaults",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));

      const wanted = [
        {
          name: "Contact us",
          kind: "contact",
          tag: "contact",
          fields: [
            {
              name: "name",
              label: "Your name",
              type: "text",
              required: true,
            },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "phone", label: "Phone", type: "tel" },
            { name: "message", label: "How can we help?", type: "textarea" },
          ],
        },
        {
          name: "Request a quote",
          kind: "quote",
          tag: "quote",
          fields: [
            {
              name: "name",
              label: "Your name",
              type: "text",
              required: true,
            },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "phone", label: "Phone", type: "tel" },
            {
              name: "details",
              label: "What needs doing?",
              type: "textarea",
              required: true,
            },
          ],
        },
      ];

      const existing = await db
        .select({ name: schema.forms.name })
        .from(schema.forms)
        .where(eq(schema.forms.organizationId, orgId));
      const have = new Set(existing.map((f) => f.name.toLowerCase()));

      const made: string[] = [];
      for (const def of wanted) {
        if (have.has(def.name.toLowerCase())) continue;
        await db.insert(schema.forms).values({
          organizationId: orgId,
          key: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
          name: def.name,
          kind: def.kind,
          tag: def.tag,
          fields: def.fields,
          // No origins listed means this site only, which is the safe
          // default for a form nobody has decided where to put yet.
          allowedOrigins: [],
        });
        made.push(def.name);
      }

      return c.json({ created: made });
    },
  );

  /**
   * Turn a submission into a deal.
   *
   * The submission already made a contact — that happens on the way in. What
   * it cannot do by itself is decide the enquiry is worth pursuing, which is
   * a judgement and therefore a button rather than an automatic step. A
   * pipeline that fills itself with every newsletter sign-up stops being
   * looked at.
   *
   * The form's tag becomes the deal's category, so "where did this come
   * from" survives into the pipeline rather than stopping at the contact.
   */
  ctx.app.post(
    "/api/forms/submissions/:id/promote",
    requireSession(),
    requirePermission({ crm: ["create"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [submission] = await db
        .select()
        .from(schema.formSubmissions)
        .where(
          and(
            eq(schema.formSubmissions.id, id),
            eq(schema.formSubmissions.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!submission) return c.json({ error: "not found" }, 404);
      if (!submission.contactId) {
        return c.json({ error: "this submission has no contact" }, 409);
      }

      const [form] = await db
        .select()
        .from(schema.forms)
        .where(eq(schema.forms.id, submission.formId))
        .limit(1);

      // Already promoted: return the deal rather than making a second one.
      // Somebody clicking twice should not end up with two identical deals
      // in the same column.
      const existing = await db
        .select()
        .from(schema.deals)
        .where(
          and(
            eq(schema.deals.organizationId, orgId),
            eq(schema.deals.sourceSubmissionId, id),
          ),
        )
        .limit(1);
      if (existing[0]) return c.json({ deal: existing[0], already: true });

      const payload = submission.payload ?? {};
      const summary =
        [payload.subject, payload.message, payload.details]
          .find((v) => typeof v === "string" && v.trim())
          ?.slice(0, 80) ??
        form?.name ??
        "Enquiry";

      const [deal] = await db
        .insert(schema.deals)
        .values({
          organizationId: orgId,
          name: summary,
          contactIds: [submission.contactId],
          stage: "opportunity",
          category: form?.tag ?? form?.name ?? null,
          description: Object.entries(payload)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n"),
          sourceSubmissionId: id,
        })
        .returning();

      return c.json({ deal }, 201);
    },
  );

  /**
   * The embed script itself.
   *
   * Public and unauthenticated by necessity — it runs on somebody else's
   * website, before anybody has filled anything in. It contains no data: the
   * form it renders is named by the tag that loaded it, and fetched at run
   * time, so one script serves every form on every instance.
   */
  ctx.app.get("/embed.js", (c) =>
    c.body(embedScript(), 200, {
      "content-type": "application/javascript; charset=utf-8",
      // Cached, but briefly. It changes when the product does, and a site
      // holding a month-old copy would miss a fix to the thing collecting
      // their leads.
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    }),
  );

  ctx.app.options("/api/embed/forms/:key", async (c) => {
    const form = await formByKey(c.req.param("key"));
    const decision = originAllowed(
      c.req.header("origin"),
      form?.allowedOrigins ?? [],
    );
    if (!form || !decision.allowed) return c.body(null, 403);
    return c.body(null, 204, corsHeaders(decision.echo));
  });

  /** The form definition, so a snippet can render fields it did not hardcode. */
  ctx.app.get("/api/embed/forms/:key", async (c) => {
    const form = await formByKey(c.req.param("key"));
    const decision = originAllowed(
      c.req.header("origin"),
      form?.allowedOrigins ?? [],
    );
    if (!form || !form.active || !decision.allowed) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(
      {
        key: form.key,
        name: form.name,
        kind: form.kind,
        fields: form.fields,
        honeypot: HONEYPOT_FIELD,
        redirectUrl: form.redirectUrl,
        style: form.style ?? null,
      },
      200,
      corsHeaders(decision.echo),
    );
  });

  ctx.app.post("/api/embed/forms/:key", async (c) => {
    const key = c.req.param("key");
    const form = await formByKey(key);
    const origin = c.req.header("origin");
    const decision = originAllowed(origin, form?.allowedOrigins ?? []);

    // One 404 for "no such form", "inactive" and "origin not allowed": a
    // public endpoint should not help someone map which keys are real.
    if (!form || !form.active || !decision.allowed) {
      return wantsHtml(c)
        ? c.html(
            problemPage(
              "This form is no longer accepting messages. Try contacting the business another way.",
            ),
            404,
          )
        : c.json({ error: "not found" }, 404);
    }

    const limited = rateLimit(
      `${key}:${c.req.header("x-real-ip") ?? origin ?? "anon"}`,
      SUBMIT_LIMIT,
      SUBMIT_WINDOW_MS,
    );
    if (!limited.allowed) {
      const retry = { "retry-after": String(limited.retryAfterSeconds) };
      return wantsHtml(c)
        ? c.html(
            problemPage(
              "That is a lot of messages in a short time. Wait a minute and try again.",
            ),
            429,
            retry,
          )
        : c.json({ error: "too_many_requests" }, 429, {
            ...corsHeaders(decision.echo),
            ...retry,
          });
    }

    /*
     * Two ways in, decided by what the form asks for.
     *
     * A form with no file field keeps the 64KB text leash it has always had.
     * One that asks for a file reads the multipart body whole, because the
     * text path decodes before it parses and a PDF does not survive that.
     */
    const accepts = fileFieldNames(form.fields);
    const multipart = (c.req.header("content-type") ?? "").includes(
      "multipart/form-data",
    );
    let uploads: [string, File][] = [];
    let payload: Record<string, string> | null;
    if (accepts.length > 0 && multipart) {
      const read = await readSubmissionWithFiles(c.req.raw);
      payload = read?.payload ?? null;
      // Anything sent under a name the form never asked for is dropped: a
      // public endpoint should not write a file nobody requested.
      uploads = (read?.files ?? []).filter(([field]) =>
        accepts.includes(field),
      );
    } else {
      payload = await readSubmission(c.req.raw);
    }
    if (payload === null) {
      return wantsHtml(c)
        ? c.html(
            problemPage(
              "That message is too long to send through this form. Shorten it, or contact the business directly.",
            ),
            413,
          )
        : c.json({ error: "too_large" }, 413, corsHeaders(decision.echo));
    }

    // Silent success for the honeypot: telling a bot it was detected only
    // teaches it to stop filling the trap.
    if (looksAutomated(payload)) {
      // The same reply a person gets, so a bot learns nothing from it.
      return wantsHtml(c)
        ? c.html(
            thanksPage(
              form.name,
              await businessName(form.organizationId),
              await creditFor(
                form.organizationId,
                ctx.entitled({ tier: "pro" }),
              ),
            ),
          )
        : c.json({ ok: true }, 202, corsHeaders(decision.echo));
    }

    const email = (payload.email ?? "").trim().toLowerCase();
    const name = (payload.name ?? "").trim();
    if (!name && !email) {
      return wantsHtml(c)
        ? c.html(
            problemPage(
              "Add your name or an email address so the business can reply, then send it again.",
            ),
            400,
          )
        : c.json(
            { error: "name or email is required" },
            400,
            corsHeaders(decision.echo),
          );
    }

    const orgId = form.organizationId;

    /*
     * Checked before it is written, and refused rather than quarantined.
     *
     * The bytes are in memory at this point and nowhere else, so a file that
     * fails never becomes a file at all. The reason is given back: somebody
     * sending a CV deserves to know it was the document and not the form.
     */
    const kept: (typeof schema.formSubmissions.$inferInsert)["attachments"] =
      [];
    for (const [field, file] of uploads) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return wantsHtml(c)
          ? c.html(
              problemPage("That file is too large. 10MB is the limit."),
              413,
            )
          : c.json({ error: "too_large" }, 413, corsHeaders(decision.echo));
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const verdict = await checkUpload(bytes);
      if (!verdict.ok) {
        const reason = `That file was not accepted: ${verdict.reason}. Send it as a PDF.`;
        return wantsHtml(c)
          ? c.html(problemPage(reason), 400)
          : c.json(
              { error: "file_rejected", message: reason },
              400,
              corsHeaders(decision.echo),
            );
      }
      const stored = await storeAttachment(orgId, file, UPLOAD_FOLDER);
      kept.push({
        field,
        ...stored,
        checkedBy: scannerAddress() ? "shape+scanner" : "shape",
      });
    }

    const contactId = await upsertContact(orgId, name, email, payload);

    let quoteId: string | undefined;
    if (form.kind === "quote") {
      quoteId = await draftQuote(orgId, contactId, payload);
    }

    const [submission] = await db
      .insert(schema.formSubmissions)
      .values({
        organizationId: orgId,
        formId: form.id,
        contactId,
        quoteId,
        payload,
        attachments: kept,
        origin,
        userAgent: c.req.header("user-agent"),
      })
      .returning();

    // The submission itself is the record; an activity puts it on the
    // contact's timeline where a salesperson will actually see it.
    await db.insert(schema.activities).values({
      organizationId: orgId,
      contactId,
      type: "note",
      body: `${form.name}: ${summarise(payload)}`,
    });

    await tellSomebody(form, payload, submission?.id, kept);

    /**
     * A browser is sent somewhere; a script is told what happened.
     *
     * 303 rather than 302 so the visitor's browser follows with GET and a
     * refresh cannot post the message a second time.
     */
    if (wantsHtml(c)) {
      return form.redirectUrl
        ? c.redirect(form.redirectUrl, 303)
        : c.html(
            thanksPage(
              form.name,
              await businessName(form.organizationId),
              await creditFor(
                form.organizationId,
                ctx.entitled({ tier: "pro" }),
              ),
            ),
            201,
          );
    }

    return c.json(
      {
        ok: true,
        submissionId: submission?.id,
        redirectUrl: form.redirectUrl ?? null,
        /*
         * The same credit the HTML reply carries, for the snippet that draws
         * its own thank-you. Without this the two paths disagree: a visitor who
         * arrived with JavaScript saw no credit and one without it did, on the
         * same form, on the same site.
         */
        credit: await creditFor(
          form.organizationId,
          ctx.entitled({ tier: "pro" }),
        ),
      },
      201,
      corsHeaders(decision.echo),
    );
  });
}

/** The name on the thank-you page is the business's own, not Sentrello's. */
async function businessName(orgId: string): Promise<string> {
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  return org?.name ?? "the business";
}

async function formByKey(key: string) {
  const [form] = await db
    .select()
    .from(schema.forms)
    .where(eq(schema.forms.key, key))
    .limit(1);
  return form;
}

/**
 * The largest submission this endpoint will read.
 *
 * A contact form is a name, an address and a few sentences; 64KB is a long
 * message and a generous allowance for the field names around it. The inbound
 * email endpoint — the other thing on this product's public surface that a
 * stranger may post to — has had a cap since it was written, and this had
 * none: `/api/embed/forms/:key` is reachable by anybody on the internet, by
 * design, and read whatever was sent.
 *
 * The rate limit above bounds how *often* somebody may post. It does nothing
 * about how much they may post at once.
 */
export const MAX_SUBMISSION_BYTES = 64 * 1024;

/**
 * The folder uploads land in, under the instance's data directory.
 *
 * Its own, not the CRM's general attachments folder. These arrived from the
 * open internet rather than from somebody signed in, they age out on a
 * schedule nothing else has, and keeping them apart means a retention sweep
 * can never reach a file a person attached to a contact by hand.
 */
export const UPLOAD_FOLDER = "form-uploads";

/**
 * The largest body this endpoint will read when the form asks for a file.
 *
 * The file's own ceiling is the SDK's, which nginx is already configured
 * around; this is that plus room for the answers travelling beside it.
 */
export const MAX_UPLOAD_BODY_BYTES = MAX_ATTACHMENT_BYTES + 256 * 1024;

/** The fields on this form that expect a file rather than an answer. */
export function fileFieldNames(
  fields: { name: string; type: string }[] | null | undefined,
): string[] {
  return (fields ?? []).filter((f) => f.type === "file").map((f) => f.name);
}

/**
 * A submission that brought files with it.
 *
 * Read straight from the request rather than through `readSubmission`, which
 * decodes the body as text first: a PDF put through a text decoder comes out
 * the other side as replacement characters and is no longer a PDF. Two paths,
 * because the text one is the leash every other form is on and moving all of
 * them onto this would raise the ceiling for forms that ask for nothing.
 */
async function readSubmissionWithFiles(req: Request): Promise<{
  payload: Record<string, string>;
  files: [string, File][];
} | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BODY_BYTES) {
    return null;
  }

  const body = await req.formData().catch(() => null);
  if (!body) return { payload: {}, files: [] };

  const payload: Record<string, string> = {};
  const files: [string, File][] = [];
  let seen = 0;
  for (const [key, entry] of body.entries()) {
    if (seen >= MAX_SUBMISSION_FIELDS) break;
    seen += 1;
    // The ambient type of a form entry is a string; a multipart body also
    // yields files, and the runtime is the authority on which this is.
    const value = entry as unknown as string | File;
    if (typeof value === "string") {
      payload[key] = value;
      continue;
    }
    // The name is shown; it is never a path, and never what the file is
    // stored as.
    payload[key] = displayFilename(value.name);
    if (value.size > 0) files.push([key, value]);
  }
  return { payload, files };
}

/** Too many boxes to be a form somebody filled in. */
const MAX_SUBMISSION_FIELDS = 100;

/**
 * The body, refused rather than read once it is past the cap.
 *
 * `content-length` is checked first because it costs nothing and rejects the
 * ordinary case before a byte of payload arrives — but it is a claim by the
 * sender, absent on a chunked request and free to lie, so the stream is
 * counted as it comes in and abandoned the moment it goes over. Whichever
 * arrives first, nothing larger than the cap is ever held in memory.
 */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_SUBMISSION_BYTES) return null;

  const reader = req.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_SUBMISSION_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Accepts JSON or a plain HTML form post, so a snippet needs no JavaScript.
 *
 * Returns `null` when the submission is too large, which the route answers
 * with a 413 rather than treating as an empty form.
 */
async function readSubmission(
  req: Request,
): Promise<Record<string, string> | null> {
  const text = await readCapped(req);
  if (text === null) return null;

  const type = req.headers.get("content-type") ?? "";
  const capped = (entries: [string, unknown][]) =>
    Object.fromEntries(
      entries
        // A form with more boxes than this was not filled in by a person.
        .slice(0, MAX_SUBMISSION_FIELDS)
        .map(([k, v]) => [k, String(v ?? "")]),
    );

  if (type.includes("application/json")) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (!body || typeof body !== "object") return {};
      return capped(Object.entries(body));
    } catch {
      return {};
    }
  }

  /*
   * Rebuilt from the text already read, rather than parsed from the request a
   * second time: the body has been consumed by the cap, and this keeps
   * multipart and url-encoded posts on exactly the same leash as JSON.
   */
  const form = await new Request("http://form.invalid", {
    method: "POST",
    headers: { "content-type": type },
    body: text,
  })
    .formData()
    .catch(() => new FormData());
  return capped([...form.entries()]);
}

/**
 * A typed name, split the way the CRM stores one.
 *
 * A form asks for "your name" in one box, because asking a stranger on a
 * website for two is a box more than they will fill in. The CRM keeps first
 * and last separately, so a lead arriving from the website opened with both
 * fields blank while the list showed its name — the same person recorded two
 * different ways depending on which screen you were looking at.
 *
 * First word, then the rest. A single word stays a first name rather than
 * being forced into a surname nobody gave: plenty of people have one name.
 */
export function splitName(full: string): {
  firstName: string | null;
  lastName: string | null;
} {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  const [first, ...rest] = parts;
  return {
    firstName: first ?? null,
    lastName: rest.length > 0 ? rest.join(" ") : null,
  };
}

/** One contact per email address: a repeat enquiry should not create a duplicate. */
async function upsertContact(
  orgId: string,
  name: string,
  email: string,
  payload: Record<string, string>,
): Promise<string> {
  if (email) {
    /*
     * Any address this person is known by, not the primary column compared
     * exactly. `Jane@Example.com` used to make a second contact beside
     * `jane@example.com`, and an enquiry from somebody's work address made one
     * beside the record that already held it.
     */
    const [existing] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(eq(schema.contacts.organizationId, orgId), contactHasEmail(email)),
      )
      .limit(1);
    if (existing) return existing.id;
  }

  const [created] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      // Both: `name` is what quotes, invoices and the portal read, and the
      // split is what the CRM's own screens edit.
      name: name || email || "Website enquiry",
      ...splitName(name),
      email: email || null,
      phone: payload.phone ?? null,
      kind: "lead",
    })
    .returning();
  if (!created) throw new Error("contact insert returned no row");
  return created.id;
}

/** A quote request becomes a draft quote for someone to price up. */
async function draftQuote(
  orgId: string,
  contactId: string,
  payload: Record<string, string>,
): Promise<string> {
  const totals = lineTotals([]);
  const quote = await db.transaction(async (tx) => {
    const [q] = await tx
      .insert(schema.quotes)
      .values({
        organizationId: orgId,
        contactId,
        number: await nextDocumentNumber(tx, orgId, "quote"),
        status: "draft",
        subtotalCents: totals.subtotal,
        taxCents: totals.tax,
        totalCents: totals.total,
      })
      .returning();
    if (!q) throw new Error("quote insert returned no row");

    // Whatever they described becomes the first line, at zero, for pricing.
    const description = payload.message ?? payload.details ?? "Quote request";
    await tx.insert(schema.quoteLines).values({
      quoteId: q.id,
      description: description.slice(0, 500),
      quantity: 1,
      unitPriceCents: 0,
      taxRateBp: 0,
    });
    return q;
  });
  return quote.id;
}

/**
 * Telling the business somebody filled the form in.
 *
 * `notifyEmail` has been stored on a form since forms existed and read by
 * nothing, so the answer to "who gets told" was nobody. A contact form whose
 * submissions only appear if somebody thinks to look is a contact form that
 * loses enquiries, which is the one thing it exists not to do.
 *
 * After the record, and never in front of it: the submission and the activity
 * are already committed when this runs, so a mail server that is down or
 * misconfigured cannot lose an enquiry. It is logged and swallowed for the
 * same reason — the visitor has already been told it went through, and
 * failing their request now would be a lie in the other direction.
 */
/**
 * The files on a submission, as links somebody can actually open.
 *
 * Its own function so it can be tested: the mail adapter is chosen from the
 * environment at the moment of sending, so there is no seam to assert through,
 * and the thing worth asserting is this — that a notification about a CV
 * carries a way to reach the CV. It did not, for its first day.
 */
/**
 * Who a form's notification comes from, and who a reply reaches.
 *
 * It came from the instance's system sender, which on this business is
 * `billing@`. A job application arriving from the billing address is wrong in
 * a way anybody notices: the address on a message is a claim about what the
 * message is.
 *
 * **Not the address it is going to, though.** That was the first attempt and
 * it is a trap: a form notification is sent *to* the notify address, so using
 * it as the sender makes a message from an address to itself. A mailbox does
 * not mind. A Google Group treats mail appearing to come from the group as a
 * loop and drops it — silently, which is the failure mode we were already
 * chasing when this was written.
 *
 * So: `no-reply` on the domain the instance already sends as, carrying the
 * form's name. It reads as what it is, it is authenticated, and it cannot be
 * mistaken for the recipient talking to itself. The reply address is the
 * person who filled the form in, which is where a reply should have gone all
 * along.
 */
export function notificationSender(
  formName: string,
  systemSender: string | undefined,
): string | undefined {
  // The system sender may be "Name <addr@domain>"; the domain is what matters.
  const domain = systemSender?.split("@").pop()?.replace(/>.*$/, "").trim();
  if (!domain || !domain.includes(".")) return undefined;
  // A display name carrying a quote or an angle bracket would break the header.
  const name = formName
    .replace(/["<>\r\n]/g, "")
    .trim()
    .slice(0, 60);
  return name ? `${name} <no-reply@${domain}>` : `no-reply@${domain}`;
}

export function attachmentLinks(
  submissionId: string | undefined,
  attachments: (typeof schema.formSubmissions.$inferInsert)["attachments"],
): string[] {
  const base = process.env.SENTRELLO_BASE_URL?.replace(/\/+$/, "");
  // No address that works from an inbox means no link worth writing: a bare
  // path in an email is a line somebody tries to click and cannot.
  if (!base || !submissionId) return [];
  return (attachments ?? []).map(
    (file, at) =>
      `<p><a href="${base}/api/forms/submissions/${submissionId}/files/${at}">${html(file.name)}</a> (${Math.ceil(file.size / 1024)}KB)</p>`,
  );
}

async function tellSomebody(
  form: { name: string; notifyEmail: string | null },
  payload: Record<string, string>,
  submissionId: string | undefined,
  attachments: (typeof schema.formSubmissions.$inferInsert)["attachments"] = [],
): Promise<void> {
  if (!form.notifyEmail) return;

  /*
   * A link to the file, not just its name.
   *
   * The payload carries what the file was called, which tells the reader a CV
   * arrived and gives them no way to open it — so the notification about an
   * application was a notification you had to go and find the application
   * from. The link needs a session, which is correct: the file is somebody
   * else's document and reading it is a thing staff do signed in.
   *
   * Without SENTRELLO_BASE_URL there is no address that works from an inbox,
   * so the line is left out rather than written as a path nobody can click.
   */
  const files = attachmentLinks(submissionId, attachments);

  try {
    /*
     * A reply goes to whoever filled the form in.
     *
     * Without it, hitting reply on an application writes back to the address
     * that sent the notification — which is the business itself. Every reply
     * would go nowhere, and the person who applied would hear nothing.
     */
    /*
     * An address, or nothing. Not "contains an @".
     *
     * Whatever a visitor typed goes into a mail header, and a header value
     * with a line break in it ends that header and begins another — so
     * `me@example.com\r\nBcc: everyone@…` passed the old check. The sender
     * drops a header like that now, which is the guard that matters; this is
     * the other half of it, so a malformed address is refused here where it
     * can be seen rather than silently dropped two layers down.
     */
    const typed = (payload.email ?? "").trim();
    const replyTo = /^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+\.[^\s<>@,;:"\\]+$/.test(
      typed,
    )
      ? typed
      : "";
    await emailAdapter().send({
      to: form.notifyEmail,
      from: notificationSender(form.name, systemFrom()),
      ...(replyTo ? { headers: { "Reply-To": replyTo } } : {}),
      subject: `${form.name}: a new enquiry`,
      // Everything here was typed by a stranger on the internet, so every
      // part of it is escaped before it becomes markup in somebody's inbox.
      html: [
        `<p>${html(form.name)} was filled in.</p>`,
        "<dl>",
        ...Object.entries(payload)
          .filter(([key]) => key !== HONEYPOT_FIELD)
          .map(
            ([key, value]) =>
              `<dt><strong>${html(key)}</strong></dt><dd>${html(value)}</dd>`,
          ),
        "</dl>",
        ...files,
        submissionId ? `<p>Reference ${html(submissionId)}</p>` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  } catch (err) {
    console.error("[crm] telling somebody about a form submission failed", err);
  }
}

function summarise(payload: Record<string, string>): string {
  return Object.entries(payload)
    .filter(([k]) => k !== HONEYPOT_FIELD)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ")
    .slice(0, 1000);
}

function defaultFields(kind: string) {
  const base = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "phone", label: "Phone", type: "tel" },
  ];
  return kind === "quote"
    ? [
        ...base,
        {
          name: "message",
          label: "What do you need a quote for?",
          type: "textarea",
          required: true,
        },
      ]
    : [...base, { name: "message", label: "Message", type: "textarea" }];
}

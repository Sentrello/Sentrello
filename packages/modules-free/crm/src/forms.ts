import { randomBytes } from "node:crypto";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, asc, db, eq, schema, sql } from "@sentrello/db";
import { lineTotals } from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import { emailAdapter } from "@sentrello/email";
import type { ModuleContext } from "@sentrello/module-sdk";
import { csvDownload, toCsv } from "@sentrello/module-sdk";
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
export function registerForms(ctx: ModuleContext) {
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

    const payload = await readSubmission(c.req.raw);

    // Silent success for the honeypot: telling a bot it was detected only
    // teaches it to stop filling the trap.
    if (looksAutomated(payload)) {
      // The same reply a person gets, so a bot learns nothing from it.
      return wantsHtml(c)
        ? c.html(thanksPage(form.name, await businessName(form.organizationId)))
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

    await tellSomebody(form, payload, submission?.id);

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
            thanksPage(form.name, await businessName(form.organizationId)),
            201,
          );
    }

    return c.json(
      {
        ok: true,
        submissionId: submission?.id,
        redirectUrl: form.redirectUrl ?? null,
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

/** Accepts JSON or a plain HTML form post, so a snippet needs no JavaScript. */
async function readSubmission(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([k, v]) => [
        k,
        String(v ?? ""),
      ]),
    );
  }
  const form = await req.formData().catch(() => new FormData());
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out;
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
    const [existing] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.organizationId, orgId),
          eq(schema.contacts.email, email),
        ),
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
async function tellSomebody(
  form: { name: string; notifyEmail: string | null },
  payload: Record<string, string>,
  submissionId: string | undefined,
): Promise<void> {
  if (!form.notifyEmail) return;

  try {
    await emailAdapter().send({
      to: form.notifyEmail,
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

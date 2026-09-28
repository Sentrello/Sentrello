import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, schema } from "@sentrello/db";
import { dateFrom } from "@sentrello/db/timezone";
import type { ModuleContext } from "@sentrello/module-sdk";
import type { IncomingLine } from "./documents";
import { usStateCode } from "./us-nexus-thresholds";

/**
 * Sales-tax exemption certificates: the evidence, and the discipline.
 *
 * A reseller or a non-profit hands over a certificate and is charged no
 * tax. In an audit the certificate is the entire defence — the state asks
 * for the document, its number, the reason, and that it was valid on the
 * day of each sale it excused. So the certificate is a record here, every
 * exempt invoice points at the one that excused it, and an expired
 * certificate stops excusing anything the moment it expires: the refusal
 * is loud, at the moment the invoice is raised, because the alternative is
 * a business quietly under-collecting on the say-so of a dead document and
 * finding out at the audit.
 */

export class ExemptionError extends Error {}

const REASONS = new Set([
  "resale",
  "nonprofit",
  "government",
  "direct-pay",
  "other",
]);

/** A certificate as the browser sent it, or a refusal naming the problem. */
function parseCertificate(body: Record<string, unknown>): {
  companyId: string;
  number: string;
  state: string;
  reason: string;
  notes: string | null;
  expiresAt: Date | null;
  documentPath: string | null;
} {
  const companyId = String(body.companyId ?? "").trim();
  if (!companyId) throw new ExemptionError("whose certificate is it?");

  const number = String(body.number ?? "").trim();
  if (!number) {
    throw new ExemptionError(
      "the certificate's number is required — it is the evidence",
    );
  }

  const state = usStateCode(String(body.state ?? ""));
  if (!state) {
    throw new ExemptionError(
      "which state issued it? (two letters, or its name)",
    );
  }

  const reason = String(body.reason ?? "resale").trim();
  if (!REASONS.has(reason)) {
    throw new ExemptionError(
      "the reason is one of: resale, nonprofit, government, direct-pay, other",
    );
  }

  let expiresAt: Date | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    // A certificate's expiry decides whether a sale is charged tax at all, so
    // a day that rolls — 30 February becoming 2 March — moves the line
    // between an excused sale and a taxable one.
    expiresAt = dateFrom(String(body.expiresAt));
    if (!expiresAt) {
      throw new ExemptionError("unreadable expiry date");
    }
  }

  return {
    companyId,
    number,
    state,
    reason,
    notes: String(body.notes ?? "").trim() || null,
    expiresAt,
    documentPath: String(body.documentPath ?? "").trim() || null,
  };
}

/** Sixty days: enough time to chase the customer for a fresh one. */
const EXPIRING_SOON_MS = 60 * 86_400_000;

function certificateStatus(
  cert: { expiresAt: Date | null; revokedAt: Date | null },
  on: Date = new Date(),
): "valid" | "expiring-soon" | "expired" | "revoked" {
  if (cert.revokedAt) return "revoked";
  if (!cert.expiresAt) return "valid";
  if (cert.expiresAt.getTime() < on.getTime()) return "expired";
  if (cert.expiresAt.getTime() < on.getTime() + EXPIRING_SOON_MS) {
    return "expiring-soon";
  }
  return "valid";
}

/**
 * The certificate that may excuse this invoice, or the refusal that stops it.
 *
 * Checked against the *issue date*, because that is the day of the sale the
 * auditor will ask about: a certificate that was still good in March excuses
 * a March invoice being entered in June, and one that died in February does
 * not — however recently somebody looked at it. The certificate must belong
 * to this organisation and to the invoice's own customer; an id from
 * anywhere else is "no such certificate", not a hint.
 */
export async function exemptionForInvoice(
  orgId: string,
  contactId: string | null | undefined,
  certificateId: unknown,
  issueDate: Date,
): Promise<string | null> {
  if (certificateId === undefined || certificateId === null) return null;
  const id = String(certificateId).trim();
  if (!id) return null;

  if (!contactId) {
    throw new ExemptionError(
      "an exempt sale needs a customer — the certificate is theirs",
    );
  }

  const [cert] = await db
    .select({
      id: schema.exemptionCertificates.id,
      companyId: schema.exemptionCertificates.companyId,
      number: schema.exemptionCertificates.number,
      expiresAt: schema.exemptionCertificates.expiresAt,
      revokedAt: schema.exemptionCertificates.revokedAt,
    })
    .from(schema.exemptionCertificates)
    .where(
      and(
        eq(schema.exemptionCertificates.id, id),
        eq(schema.exemptionCertificates.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!cert) throw new ExemptionError("no such exemption certificate");

  const [contact] = await db
    .select({ companyId: schema.contacts.companyId })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.id, contactId),
        eq(schema.contacts.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!contact?.companyId || contact.companyId !== cert.companyId) {
    throw new ExemptionError(
      "that certificate belongs to a different customer",
    );
  }

  if (cert.revokedAt) {
    throw new ExemptionError(
      `certificate ${cert.number} has been revoked and cannot exempt a sale`,
    );
  }
  if (cert.expiresAt && cert.expiresAt.getTime() < issueDate.getTime()) {
    throw new ExemptionError(
      `certificate ${cert.number} expired on ${cert.expiresAt.toISOString().slice(0, 10)} — the sale cannot be exempted under it. Record the customer's new certificate first.`,
    );
  }
  return cert.id;
}

/**
 * The organisation's exempt rate, found or made.
 *
 * Exempt sales still band: the document, the e-invoice and the filing
 * report all state "this much was sold exempt", which is a figure state
 * returns ask for. One zero-rate E definition per organisation carries it.
 */
export async function ensureExemptDefinition(orgId: string): Promise<string> {
  const [existing] = await db
    .select({ id: schema.taxDefinitions.id })
    .from(schema.taxDefinitions)
    .where(
      and(
        eq(schema.taxDefinitions.organizationId, orgId),
        eq(schema.taxDefinitions.categoryCode, "E"),
        eq(schema.taxDefinitions.active, true),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [made] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: "Exempt",
      rateBp: 0,
      ratePpm: 0,
      categoryCode: "E",
      appliesTo: "sales",
      recoverable: false,
    })
    .returning({ id: schema.taxDefinitions.id });
  if (!made) throw new Error("tax definition insert returned no row");
  return made.id;
}

/**
 * Every line charged at Exempt, whatever the browser put on it.
 *
 * Forced rather than trusted: a sale under a certificate charges no tax on
 * any line, and a document that exempts three lines while taxing a fourth
 * is a document neither the customer nor the auditor can read.
 */
export function exemptLines(
  lines: IncomingLine[],
  exemptDefinitionId: string,
): IncomingLine[] {
  return lines.map((line) => ({
    ...line,
    taxDefinitionId: undefined,
    taxDefinitionIds: [exemptDefinitionId],
    taxRatePpm: undefined,
    taxRateBp: undefined,
  }));
}

export function registerExemptions(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/exemptions",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select({
          certificate: schema.exemptionCertificates,
          companyName: schema.companies.name,
        })
        .from(schema.exemptionCertificates)
        .leftJoin(
          schema.companies,
          and(
            eq(schema.exemptionCertificates.companyId, schema.companies.id),
            eq(schema.companies.organizationId, orgId),
          ),
        )
        .where(eq(schema.exemptionCertificates.organizationId, orgId))
        .orderBy(desc(schema.exemptionCertificates.createdAt));
      return c.json({
        certificates: rows.map((row) => ({
          ...row.certificate,
          companyName: row.companyName,
          status: certificateStatus(row.certificate),
        })),
      });
    },
  );

  ctx.app.post(
    "/api/invoicing/exemptions",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      let parsed: ReturnType<typeof parseCertificate>;
      try {
        parsed = parseCertificate(body);
      } catch (err) {
        if (err instanceof ExemptionError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }

      // The company has to be this organisation's — a certificate attached
      // to a stranger's record is evidence for nobody.
      const [company] = await db
        .select({ id: schema.companies.id })
        .from(schema.companies)
        .where(
          and(
            eq(schema.companies.id, parsed.companyId),
            eq(schema.companies.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!company) return c.json({ error: "no such company" }, 404);

      const [made] = await db
        .insert(schema.exemptionCertificates)
        .values({ organizationId: orgId, ...parsed })
        .returning();
      if (!made) throw new Error("certificate insert returned no row");
      return c.json(
        { certificate: { ...made, status: certificateStatus(made) } },
        201,
      );
    },
  );

  /**
   * Revoked, never deleted: invoices reference certificates as audit
   * evidence, and the evidence for a past sale must outlive the customer
   * relationship that produced it.
   */
  ctx.app.post(
    "/api/invoicing/exemptions/:id/revoke",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .update(schema.exemptionCertificates)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.exemptionCertificates.id, c.req.param("id")),
            eq(schema.exemptionCertificates.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({
        certificate: { ...row, status: certificateStatus(row) },
      });
    },
  );
}

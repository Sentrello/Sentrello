import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";

/**
 * Checking a customer's VAT number against VIES, the EU's own register.
 *
 * Zero-rating a cross-border B2B sale rests on the customer being VAT
 * registered, and the seller is the one who has to show it. So this does more
 * than say yes or no: a successful check is written onto the company record —
 * the answer, the date, and the registered name the member state returned —
 * because "we checked on this date and the register agreed" is what a tax
 * inspection accepts as evidence, and a number that merely looked plausible
 * is not.
 *
 * VIES is a facade over twenty-seven national registers and any one of them
 * is regularly down. An outage is therefore its own answer, distinct from
 * "invalid": it writes nothing, so a number the register confirmed last month
 * is never turned bad by a register that failed to answer today.
 */

/**
 * The prefixes VIES accepts: the member states, with Greece under its VAT
 * prefix EL, and XI for Northern Ireland goods traders under the Protocol.
 */
const VIES_PREFIXES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "XI",
]);

/**
 * An identifier as VIES wants it: prefix and number, spacing and punctuation
 * gone. "GR" is read as Greece's VAT prefix "EL", because people type the
 * country code they know. Null means this is not an EU VAT number at all —
 * an EIN or a GST number is not wrong, it is just not VIES's to answer.
 */
export function parseEuVat(
  raw: string,
): { countryCode: string; vatNumber: string } | null {
  const cleaned = raw.toUpperCase().replace(/[\s.-]/g, "");
  const prefix = cleaned.slice(0, 2);
  const countryCode = prefix === "GR" ? "EL" : prefix;
  const vatNumber = cleaned.slice(2);
  if (!VIES_PREFIXES.has(countryCode)) return null;
  if (vatNumber.length < 2 || !/^[A-Z0-9+*]+$/.test(vatNumber)) return null;
  return { countryCode, vatNumber };
}

export interface ViesAnswer {
  status: "valid" | "invalid" | "unavailable";
  /** The registered name, when the member state discloses one. */
  name: string | null;
}

const VIES_URL =
  "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

/**
 * One lookup, three honest outcomes.
 *
 * The service answers 200 for everything, including its own failures: an
 * unreachable member state comes back as `actionSucceed: false` with an error
 * wrapper (MS_UNAVAILABLE, TIMEOUT, SERVICE_UNAVAILABLE). Those, any
 * non-200, a malformed body and a network failure are all "unavailable" —
 * never "invalid", because the difference is the difference between "try
 * again tomorrow" and "stop zero-rating this customer".
 */
export async function checkWithVies(
  countryCode: string,
  vatNumber: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ViesAnswer> {
  try {
    const res = await fetchImpl(VIES_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ countryCode, vatNumber }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { status: "unavailable", name: null };
    const body = (await res.json()) as {
      valid?: unknown;
      actionSucceed?: unknown;
      name?: unknown;
    };
    if (body.actionSucceed === false || typeof body.valid !== "boolean") {
      return { status: "unavailable", name: null };
    }
    // "---" is VIES for "no name disclosed", not a name.
    const name =
      body.valid && typeof body.name === "string" && body.name !== "---"
        ? body.name
        : null;
    return { status: body.valid ? "valid" : "invalid", name };
  } catch {
    return { status: "unavailable", name: null };
  }
}

export function registerVies(ctx: ModuleContext) {
  ctx.app.post(
    "/api/companies/:id/vat-check",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [company] = await db
        .select()
        .from(schema.companies)
        .where(
          and(
            eq(schema.companies.id, c.req.param("id")),
            eq(schema.companies.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!company) return c.json({ error: "not found" }, 404);

      if (!company.taxIdentifier?.trim()) {
        return c.json(
          { error: "this company has no VAT number to check" },
          400,
        );
      }
      const parsed = parseEuVat(company.taxIdentifier);
      if (!parsed) {
        return c.json(
          {
            error:
              "that is not an EU VAT number — VIES only answers for EU registrations, prefixed with the country (DE, FR, IE…)",
          },
          400,
        );
      }

      const answer = await checkWithVies(parsed.countryCode, parsed.vatNumber);
      if (answer.status === "unavailable") {
        // Nothing written: the record keeps whatever the register last said.
        return c.json(
          {
            status: "unavailable",
            error:
              "VIES could not be reached — the member state's register may be down; the number has not been marked invalid, try again later",
          },
          503,
        );
      }

      const checkedAt = new Date();
      const [updated] = await db
        .update(schema.companies)
        .set({
          taxIdentifierValid: answer.status === "valid",
          taxIdentifierCheckedAt: checkedAt,
          taxIdentifierCheckedName: answer.name,
        })
        .where(eq(schema.companies.id, company.id))
        .returning();

      return c.json({ status: answer.status, company: updated });
    },
  );
}

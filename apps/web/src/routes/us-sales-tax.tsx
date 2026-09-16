import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Company, api } from "../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Select,
  Table,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * US sales tax, on one page: where the business stands against each state's
 * economic-nexus threshold, the exemption certificates it holds, and the
 * filing figures for a period.
 *
 * Like the VAT return, this computes and never files — state portals are
 * typed into by a person, after the person has checked the numbers. And like
 * the rest of the platform, it stays quiet where it does not apply: a
 * business with no US sales sees empty tables and one sentence saying why.
 */

interface NexusState {
  state: string;
  yearCents: number;
  priorYearCents: number;
  yearTransactions: number;
  priorYearTransactions: number;
  threshold: { salesCents: number; transactions: number | null } | null;
  collecting: boolean;
  status: string;
  advice: string;
}

function NexusCard() {
  const nexus = useQuery({
    queryKey: ["invoicing", "us-nexus"],
    queryFn: () =>
      api<{
        checked: string;
        states: NexusState[];
        unattributedCents: number;
        basis: string;
      }>("/api/invoicing/us-nexus"),
  });
  if (nexus.isLoading) return <Loading />;
  if (nexus.error) return <ErrorNote error={nexus.error} />;

  const states = nexus.data?.states ?? [];
  const standing: Record<string, string> = {
    over: "Over the threshold",
    approaching: "Approaching",
    under: "Under",
    "no-sales-tax": "No sales tax",
    unknown: "Compare yourself",
  };

  return (
    <Card>
      <p className="mb-1 font-medium">Where you stand, state by state</p>
      <p className="mb-3 text-sm" style={muted}>
        A state can make you collect its sales tax once your sales into it pass
        its economic-nexus threshold. These are your issued invoices, net of
        tax, against each state's line — thresholds as checked on{" "}
        {nexus.data?.checked}. Registering is your decision, and your
        accountant's; this page only makes sure you hear about it first.
      </p>
      {states.length === 0 ? (
        <p className="text-sm" style={muted}>
          No sales into US states yet — nothing to watch.
        </p>
      ) : (
        <Table
          headers={[
            "State",
            "This year",
            "Last year",
            "Sales",
            "Threshold",
            "Standing",
          ]}
        >
          {states.map((s) => (
            <Row key={s.state}>
              <td className="py-2">
                {s.state}
                {s.collecting ? (
                  <span className="ml-2 text-xs" style={muted}>
                    collecting
                  </span>
                ) : null}
              </td>
              <td className="whitespace-nowrap">{formatMoney(s.yearCents)}</td>
              <td className="whitespace-nowrap" style={muted}>
                {formatMoney(s.priorYearCents)}
              </td>
              <td style={muted}>{s.yearTransactions}</td>
              <td className="whitespace-nowrap" style={muted}>
                {s.threshold ? formatMoney(s.threshold.salesCents) : "—"}
                {s.threshold?.transactions
                  ? ` / ${s.threshold.transactions} sales`
                  : ""}
              </td>
              <td
                style={
                  s.status === "over" || s.status === "approaching"
                    ? { color: "var(--color-danger)" }
                    : muted
                }
                title={s.advice}
              >
                {standing[s.status] ?? s.status}
              </td>
            </Row>
          ))}
        </Table>
      )}
      {(nexus.data?.unattributedCents ?? 0) !== 0 ? (
        <p className="mt-2 text-sm" style={muted}>
          {formatMoney(nexus.data?.unattributedCents ?? 0)} of US sales could
          not be placed in a state — customers without a company record, or with
          a state that could not be read. Every column above is a floor.
        </p>
      ) : null}
      <p className="mt-2 text-xs" style={muted}>
        {nexus.data?.basis}
      </p>
    </Card>
  );
}

/** The quarter we are in, as the period a filing usually covers. */
function currentQuarter(): { from: string; to: string } {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  const from = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0));
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

function FilingCard() {
  const [{ from, to }, setPeriod] = useState(currentQuarter());
  const report = useQuery({
    queryKey: ["invoicing", "us-filing", from, to],
    enabled: Boolean(from && to),
    queryFn: () =>
      api<{
        jurisdictions: {
          jurisdiction: string;
          names: string[];
          taxableCents: number;
          taxCents: number;
          ledgerTaxCents: number;
        }[];
        exempt: { state: string; exemptCents: number; invoices: number }[];
      }>(`/api/invoicing/us-filing?from=${from}&to=${to}`),
  });

  return (
    <Card>
      <p className="mb-1 font-medium">Filing figures</p>
      <p className="mb-3 text-sm" style={muted}>
        Taxable sales and tax collected, per jurisdiction, for the period — with
        the same figure read back from that jurisdiction's own ledger account
        beside it. The two agreeing is the check to run before you type anything
        into a state's portal.
      </p>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="From">
          <Input
            type="date"
            value={from}
            onChange={(e) => setPeriod({ from: e.target.value, to })}
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={to}
            onChange={(e) => setPeriod({ from, to: e.target.value })}
          />
        </Field>
      </div>
      {report.isLoading ? <Loading /> : null}
      {report.error ? <ErrorNote error={report.error} /> : null}
      {report.data ? (
        report.data.jurisdictions.length === 0 ? (
          <p className="text-sm" style={muted}>
            No US sales tax collected in this period.
          </p>
        ) : (
          <Table
            headers={[
              "Jurisdiction",
              "Rates",
              "Taxable",
              "Collected",
              "In the books",
            ]}
          >
            {report.data.jurisdictions.map((j) => (
              <Row key={j.jurisdiction}>
                <td className="py-2">{j.jurisdiction}</td>
                <td style={muted}>{j.names.join(", ")}</td>
                <td className="whitespace-nowrap">
                  {formatMoney(j.taxableCents)}
                </td>
                <td className="whitespace-nowrap">{formatMoney(j.taxCents)}</td>
                <td
                  className="whitespace-nowrap"
                  style={
                    j.ledgerTaxCents === j.taxCents
                      ? muted
                      : { color: "var(--color-danger)" }
                  }
                  title={
                    j.ledgerTaxCents === j.taxCents
                      ? "The documents and the ledger agree."
                      : "The documents and the ledger disagree — check before filing."
                  }
                >
                  {formatMoney(j.ledgerTaxCents)}
                </td>
              </Row>
            ))}
          </Table>
        )
      ) : null}
      {report.data && report.data.exempt.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-sm font-medium">Exempt sales</p>
          <Table headers={["State", "Exempt sales", "Invoices"]}>
            {report.data.exempt.map((e) => (
              <Row key={e.state}>
                <td className="py-2">{e.state}</td>
                <td className="whitespace-nowrap">
                  {formatMoney(e.exemptCents)}
                </td>
                <td style={muted}>{e.invoices}</td>
              </Row>
            ))}
          </Table>
        </div>
      ) : null}
    </Card>
  );
}

interface Certificate {
  id: string;
  companyId: string;
  companyName: string | null;
  number: string;
  state: string;
  reason: string;
  notes: string | null;
  expiresAt: string | null;
  documentPath: string | null;
  status: string;
}

function CertificatesCard() {
  const qc = useQueryClient();
  const certificates = useQuery({
    queryKey: ["invoicing-exemptions"],
    queryFn: () =>
      api<{ certificates: Certificate[] }>("/api/invoicing/exemptions"),
  });
  const companies = useQuery({
    queryKey: ["companies", "all"],
    queryFn: () => api<{ companies: Company[] }>("/api/companies"),
  });

  const [companyId, setCompanyId] = useState("");
  const [number, setNumber] = useState("");
  const [state, setState] = useState("");
  const [reason, setReason] = useState("resale");
  const [expiresAt, setExpiresAt] = useState("");
  const [documentPath, setDocumentPath] = useState("");

  const done = () =>
    qc.invalidateQueries({ queryKey: ["invoicing-exemptions"] });

  const add = useMutation({
    mutationFn: () =>
      api("/api/invoicing/exemptions", {
        method: "POST",
        body: JSON.stringify({
          companyId,
          number: number.trim(),
          state: state.trim(),
          reason,
          expiresAt: expiresAt || null,
          documentPath: documentPath.trim() || null,
        }),
      }),
    onSuccess: () => {
      setNumber("");
      setState("");
      setExpiresAt("");
      setDocumentPath("");
      done();
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/exemptions/${id}/revoke`, { method: "POST" }),
    onSuccess: done,
  });

  const rows = certificates.data?.certificates ?? [];
  const statusLabel: Record<string, string> = {
    valid: "Valid",
    "expiring-soon": "Expiring soon",
    expired: "Expired",
    revoked: "Revoked",
  };

  return (
    <Card>
      <p className="mb-1 font-medium">Exemption certificates</p>
      <p className="mb-3 text-sm" style={muted}>
        A reseller, non-profit or government customer hands you a certificate
        and is charged no tax — and in an audit the certificate is the whole
        defence. Record it here, pick it when you invoice them, and an expired
        one stops working out loud rather than quietly under-collecting.
      </p>
      {rows.length > 0 ? (
        <Table
          headers={["Customer", "State", "Number", "Reason", "Expires", "", ""]}
        >
          {rows.map((cert) => (
            <Row key={cert.id}>
              <td className="py-2">{cert.companyName ?? "—"}</td>
              <td>{cert.state}</td>
              <td style={muted}>
                {cert.documentPath ? (
                  <a
                    href={cert.documentPath}
                    target="_blank"
                    rel="noreferrer"
                    className="link-muted"
                    title="Opens the scanned certificate"
                  >
                    {cert.number}
                  </a>
                ) : (
                  cert.number
                )}
              </td>
              <td style={muted}>{cert.reason}</td>
              <td style={muted}>
                {cert.expiresAt ? cert.expiresAt.slice(0, 10) : "No expiry"}
              </td>
              <td
                style={
                  cert.status === "valid"
                    ? muted
                    : { color: "var(--color-danger)" }
                }
              >
                {statusLabel[cert.status] ?? cert.status}
              </td>
              <td className="text-right">
                {cert.status !== "revoked" ? (
                  <button
                    type="button"
                    className="text-sm link-muted"
                    // Revoked, never deleted: past invoices cite it.
                    title="Stops it exempting anything; past invoices keep the reference"
                    onClick={() => revoke.mutate(cert.id)}
                  >
                    Revoke
                  </button>
                ) : null}
              </td>
            </Row>
          ))}
        </Table>
      ) : (
        <p className="text-sm" style={muted}>
          None yet. Add one when an exempt customer gives you theirs.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Customer">
          <Select
            value={companyId}
            className="w-48"
            onChange={(e) => setCompanyId(e.target.value)}
          >
            <option value="">Choose a company</option>
            {(companies.data?.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Certificate number">
          <Input
            value={number}
            placeholder="As printed on it"
            className="w-40"
            onChange={(e) => setNumber(e.target.value)}
          />
        </Field>
        <Field label="State">
          <Input
            value={state}
            placeholder="TX"
            className="w-20"
            onChange={(e) => setState(e.target.value)}
          />
        </Field>
        <Field label="Reason">
          <Select
            value={reason}
            className="w-36"
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="resale">Resale</option>
            <option value="nonprofit">Non-profit</option>
            <option value="government">Government</option>
            <option value="direct-pay">Direct pay</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Expires" hint="Leave blank if it has no stated expiry.">
          <Input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </Field>
        <Field
          label="Scan"
          hint="A link to the document — your drive, or anywhere it lives."
        >
          <Input
            value={documentPath}
            placeholder="https://…"
            className="w-52"
            onChange={(e) => setDocumentPath(e.target.value)}
          />
        </Field>
        <Button
          onClick={() => add.mutate()}
          disabled={
            add.isPending || !companyId || !number.trim() || !state.trim()
          }
        >
          Add it
        </Button>
      </div>
      {add.error ? <ErrorNote error={add.error} /> : null}
      {revoke.error ? <ErrorNote error={revoke.error} /> : null}
    </Card>
  );
}

export function UsSalesTax() {
  return (
    <div className="space-y-4">
      <NexusCard />
      <CertificatesCard />
      <FilingCard />
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import {
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Table,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * Canadian sales tax, on one page — and only the returns this business's
 * own tax rates call for. Canada is not one return: GST/HST goes to the
 * CRA, Quebec's QST to Revenu Québec, and a PST province's tax to that
 * province, separately. A business in one province sees its one or two
 * returns and never meets the machinery for the others.
 *
 * Like the VAT return and the US page, this computes and never files —
 * NETFILE and the provincial portals are typed into by a person, after the
 * person has checked the numbers.
 */

interface ReturnLine {
  definitionId: string;
  name: string;
  jurisdiction: string | null;
  collectedCents: number;
  paidOnPurchasesCents: number;
  documentTaxCents: number;
  documentTaxableCents: number;
}

interface CaReturnsPayload {
  gstHst: {
    line101SalesCents: number;
    line105CollectedCents: number;
    line108ItcsCents: number;
    line109NetTaxCents: number;
    taxes: ReturnLine[];
  } | null;
  qst: {
    line201SalesCents: number;
    line205CollectedCents: number;
    line208ItrsCents: number;
    line209NetTaxCents: number;
    taxes: ReturnLine[];
  } | null;
  pst: {
    jurisdiction: string;
    salesCents: number;
    collectedCents: number;
    dueCents: number;
    taxes: ReturnLine[];
  }[];
  notes: string[];
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

/** A return's lines as the form shows them: label, then the figure. */
function FormLines({ lines }: { lines: [string, number][] }) {
  return (
    <Table headers={["Line", "Amount"]}>
      {lines.map(([label, cents]) => (
        <Row key={label}>
          <td className="py-2">{label}</td>
          <td className="whitespace-nowrap">{formatMoney(cents)}</td>
        </Row>
      ))}
    </Table>
  );
}

/**
 * Each rate's ledger figure with the documents' answer beside it. The two
 * agreeing is the check to run before typing anything into a portal.
 */
function Reconciliation({ taxes }: { taxes: ReturnLine[] }) {
  return (
    <div className="mt-3">
      <p className="mb-1 text-sm font-medium">Rate by rate</p>
      <Table headers={["Rate", "Taxable", "Collected", "On the documents"]}>
        {taxes.map((t) => (
          <Row key={t.definitionId}>
            <td className="py-2">{t.name}</td>
            <td className="whitespace-nowrap" style={muted}>
              {formatMoney(t.documentTaxableCents)}
            </td>
            <td className="whitespace-nowrap">
              {formatMoney(t.collectedCents)}
            </td>
            <td
              className="whitespace-nowrap"
              style={
                t.documentTaxCents === t.collectedCents
                  ? muted
                  : { color: "var(--text-danger)" }
              }
              title={
                t.documentTaxCents === t.collectedCents
                  ? "The documents and the ledger agree."
                  : "The documents and the ledger disagree — check before filing."
              }
            >
              {formatMoney(t.documentTaxCents)}
            </td>
          </Row>
        ))}
      </Table>
    </div>
  );
}

export function CanadianTax() {
  const [{ from, to }, setPeriod] = useState(currentQuarter());
  const report = useQuery({
    queryKey: ["accounting", "ca-returns", from, to],
    enabled: Boolean(from && to),
    queryFn: () =>
      api<CaReturnsPayload>(`/api/accounting/ca-returns?from=${from}&to=${to}`),
  });

  const data = report.data;
  const nothing = data && !data.gstHst && !data.qst && data.pst.length === 0;

  return (
    <div className="flex flex-col gap-(--gap-stack)">
      <Card>
        <p className="mb-1 font-medium">Canadian returns for a period</p>
        <p className="mb-3 text-sm" style={muted}>
          Computed from your books the moment you ask, never kept as a running
          tally. Each figure lands on the return of the government it is owed
          to: GST/HST federally, QST to Revenu Québec, a province's PST to the
          province.
        </p>
        <div className="flex flex-wrap items-end gap-2">
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
        {nothing ? (
          <p className="mt-3 text-sm" style={muted}>
            No Canadian tax rates yet. Give a rate a Canadian jurisdiction in
            invoice settings — CA for GST, CA-ON for Ontario's HST, CA-QC for
            QST, CA-BC for BC's PST — and its return appears here on its own.
          </p>
        ) : null}
      </Card>

      {data?.gstHst ? (
        <Card>
          <p className="mb-1 font-medium">GST/HST return — CRA</p>
          <p className="mb-3 text-sm" style={muted}>
            One federal return covers GST and every harmonised province's HST.
            The line numbers are the CRA's own.
          </p>
          <FormLines
            lines={[
              [
                "101 — Sales and other revenue, excluding tax",
                data.gstHst.line101SalesCents,
              ],
              [
                "105 — GST/HST collected or collectible",
                data.gstHst.line105CollectedCents,
              ],
              ["108 — Input tax credits", data.gstHst.line108ItcsCents],
              ["109 — Net tax", data.gstHst.line109NetTaxCents],
            ]}
          />
          <Reconciliation taxes={data.gstHst.taxes} />
        </Card>
      ) : null}

      {data?.qst ? (
        <Card>
          <p className="mb-1 font-medium">QST return — Revenu Québec</p>
          <p className="mb-3 text-sm" style={muted}>
            Filed together with your GST on the combined form, but a separate
            tax with a separate net — the QST side never nets against the GST
            side.
          </p>
          <FormLines
            lines={[
              [
                "201 — Sales and other revenue, excluding tax",
                data.qst.line201SalesCents,
              ],
              [
                "205 — QST collected or collectible",
                data.qst.line205CollectedCents,
              ],
              ["208 — Input tax refunds", data.qst.line208ItrsCents],
              ["209 — Net tax", data.qst.line209NetTaxCents],
            ]}
          />
          <Reconciliation taxes={data.qst.taxes} />
        </Card>
      ) : null}

      {(data?.pst ?? []).map((p) => (
        <Card key={p.jurisdiction}>
          <p className="mb-1 font-medium">
            {p.jurisdiction.replace("CA-", "")} provincial sales tax return
          </p>
          <p className="mb-3 text-sm" style={muted}>
            Filed to the province, separately from GST/HST. Nothing you paid on
            your own purchases nets against this — provincial sales tax is not
            recoverable.
          </p>
          <FormLines
            lines={[
              ["Total sales and leases, excluding tax", p.salesCents],
              ["Tax collected on sales", p.collectedCents],
              ["Due before the province's own reductions", p.dueCents],
            ]}
          />
          <Reconciliation taxes={p.taxes} />
        </Card>
      ))}

      {data && !nothing ? (
        <Card>
          <p className="mb-1 font-medium">Before you file</p>
          <ul
            className="list-disc flex flex-col gap-(--gap-toolbar) pl-5 text-sm"
            style={muted}
          >
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

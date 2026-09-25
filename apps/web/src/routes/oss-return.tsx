import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import {
  Card,
  ErrorNote,
  Field,
  Loading,
  Row,
  Select,
  Table,
  Warning,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The EU One Stop Shop return, on one page: the figures a business copies
 * into its member state's portal, for a quarter.
 *
 * Like the VAT return and the US filing figures, this computes and never
 * files — and unlike those two it has to say so especially plainly, because
 * OSS is one return covering twenty-six other countries and a missed deadline
 * is a penalty in each of them. The sentence is at the top, in the file, and
 * in the API response, so it cannot be lost on the way to whoever acts on it.
 */

interface OssLine {
  memberState: string;
  ratePpm: number;
  supplyType: "goods" | "services" | "unclassified";
  taxableCents: number;
  vatCents: number;
}

interface OssCorrection {
  memberState: string;
  period: string;
  taxableCents: number;
  vatCents: number;
  withinThreeYears: boolean;
}

interface OssReturn {
  applies: boolean;
  year: number;
  quarter: number;
  dueDate: string;
  conversion: {
    from: string;
    rateMicro: number;
    asOf: string;
    prescribed: boolean;
  } | null;
  lines: OssLine[];
  corrections: OssCorrection[];
  totalTaxableCents: number;
  totalVatCents: number;
  /**
   * Sales that are not on the return, and why — never a silent zero.
   *
   * `no-rate-set` is the one that costs money: placed in a member state,
   * charged nothing, and no rate on record to say the nothing was meant.
   */
  omissions: {
    reason: "no-place" | "no-rate-set" | "no-rate";
    memberState?: string;
    sales: number;
    netCents: number;
    vatCents: number;
  }[];
  problem: string | null;
  filing: string;
  caveats: string[];
}

/** Millionths as a percentage: 190,000 → "19%", 99,750 → "9.975%". */
function percent(ppm: number): string {
  return `${String(ppm / 10_000).replace(/\.?0+$/, "")}%`;
}

/** The last completed quarter — the one a business is most likely filing. */
function lastQuarter(): { year: number; quarter: number } {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return q === 1
    ? { year: now.getUTCFullYear() - 1, quarter: 4 }
    : { year: now.getUTCFullYear(), quarter: q - 1 };
}

const SUPPLY: Record<string, string> = {
  goods: "Goods",
  services: "Services",
  unclassified: "Not classified",
};

export function OssReturn() {
  const [{ year, quarter }, setPeriod] = useState(lastQuarter());
  const report = useQuery({
    queryKey: ["invoicing", "oss-return", year, quarter],
    queryFn: () =>
      api<OssReturn>(
        `/api/invoicing/oss-return?year=${year}&quarter=${quarter}`,
      ),
  });

  const years = [0, 1, 2, 3].map((back) => new Date().getUTCFullYear() - back);
  const data = report.data;

  return (
    <div className="flex flex-col gap-(--gap-stack)">
      <Card>
        <p className="mb-1 font-medium">EU One Stop Shop return</p>
        <p className="mb-3 text-sm" style={muted}>
          Once your sales to consumers in other member states pass €10,000 a
          year, VAT is due at your customer's rate in your customer's country —
          reported on one quarterly return instead of a registration in each of
          them. These are the figures that return asks for: per member state,
          per rate, in euro.
        </p>
        <p
          className="mb-3 rounded p-2 text-sm"
          style={{ background: "var(--surface-sunken)" }}
        >
          <strong>This computes your return; it does not file it.</strong>{" "}
          Nothing here is sent anywhere. Your OSS return is submitted through
          your own member state's portal, by you, by the last day of the month
          after the quarter ends.
        </p>

        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Year">
            <Select
              value={String(year)}
              className="w-28"
              onChange={(e) =>
                setPeriod({ year: Number(e.target.value), quarter })
              }
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Quarter">
            <Select
              value={String(quarter)}
              className="w-28"
              onChange={(e) =>
                setPeriod({ year, quarter: Number(e.target.value) })
              }
            >
              {[1, 2, 3, 4].map((q) => (
                <option key={q} value={q}>
                  Q{q}
                </option>
              ))}
            </Select>
          </Field>
          <a
            className="link-muted pb-2 text-sm"
            href={`/api/invoicing/oss-return?year=${year}&quarter=${quarter}&format=csv`}
            // Kept, not just read: the records behind an OSS return have to be
            // produceable for ten years, and a figure that exists only on a
            // screen is not kept.
            title="Saves these figures as a spreadsheet, for your records"
          >
            Save as a file
          </a>
        </div>

        {report.isLoading ? <Loading /> : null}
        {report.error ? <ErrorNote error={report.error} /> : null}

        {data && !data.applies ? (
          <p className="text-sm" style={muted}>
            Your business is not in an EU member state, so the Union scheme is
            not yours to use. Set your country under Settings if that is wrong.
          </p>
        ) : null}

        {data?.problem ? <Warning>{data.problem}</Warning> : null}

        {data?.applies && !data.problem ? (
          <>
            <p className="mb-2 text-sm" style={muted}>
              {data.year} Q{data.quarter} — return and payment due{" "}
              <strong>{data.dueDate.slice(0, 10)}</strong>.
              {data.conversion
                ? ` Converted from ${data.conversion.from} at the European Central Bank rate for ${data.conversion.asOf.slice(0, 10)}${
                    data.conversion.prescribed
                      ? "."
                      : " — which is not the quarter-end rate the rules prescribe. Record that day's rate under Accounting and these figures will be exact."
                  }`
                : ""}
            </p>
            {/*
             * Above the figures, not under them.
             *
             * A sale the return could not take is the reason the figures below
             * are smaller than the business's own trading, and reading the
             * total first and the reason last is how somebody files the total.
             */}
            {data.omissions.length > 0 ? (
              <ul
                className="mb-3 flex flex-col gap-(--gap-tight) text-sm"
                style={{ color: "var(--text-danger)" }}
              >
                {data.omissions.map((omission) => (
                  <li key={`${omission.reason}-${omission.memberState ?? ""}`}>
                    {omission.reason === "no-rate-set" ? (
                      <>
                        <strong>
                          {omission.sales} sale
                          {omission.sales === 1 ? "" : "s"} into{" "}
                          {omission.memberState} charged no VAT
                        </strong>{" "}
                        — {formatMoney(omission.netCents)} of supplies, and no{" "}
                        {omission.memberState} rate is set. VAT is due there
                        from the first sale, with no threshold under it. Not on
                        this return: declaring it at 0% would say no tax was
                        due.
                      </>
                    ) : omission.reason === "no-place" ? (
                      <>
                        <strong>
                          {omission.sales} sale
                          {omission.sales === 1 ? "" : "s"} could not be placed
                        </strong>{" "}
                        — {formatMoney(omission.netCents)} of supplies with
                        nothing recording which country they belong to, so none
                        of them are counted here.
                      </>
                    ) : (
                      <>
                        <strong>
                          {omission.sales} sale
                          {omission.sales === 1 ? "" : "s"}
                          {omission.memberState
                            ? ` into ${omission.memberState}`
                            : ""}{" "}
                          carry tax at a rate nothing records
                        </strong>{" "}
                        — {formatMoney(omission.vatCents)} on{" "}
                        {formatMoney(omission.netCents)} of supplies. Not on
                        this return until the rate is recorded.
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}

            {data.lines.length === 0 ? (
              <p className="text-sm" style={muted}>
                No sales to consumers in other member states this quarter. A nil
                return is still due — the obligation is to file, not to have
                traded.
              </p>
            ) : (
              <Table
                headers={[
                  "Member State",
                  "VAT rate",
                  "Supply",
                  "Taxable amount",
                  "VAT due",
                ]}
              >
                {data.lines.map((line) => (
                  <Row
                    key={`${line.memberState}-${line.ratePpm}-${line.supplyType}`}
                  >
                    <td className="py-2">{line.memberState}</td>
                    <td>{percent(line.ratePpm)}</td>
                    <td style={muted}>
                      {SUPPLY[line.supplyType] ?? line.supplyType}
                    </td>
                    <td className="whitespace-nowrap">
                      {formatMoney(line.taxableCents, "EUR")}
                    </td>
                    <td className="whitespace-nowrap">
                      {formatMoney(line.vatCents, "EUR")}
                    </td>
                  </Row>
                ))}
              </Table>
            )}

            {data.corrections.length > 0 ? (
              <div className="mt-4">
                <p className="mb-1 text-sm font-medium">
                  Corrections to earlier quarters
                </p>
                <p className="mb-2 text-sm" style={muted}>
                  A return that has been filed cannot be amended. A credit note
                  against an earlier quarter's invoice goes in the correction
                  panel of this return instead, naming the quarter it relates
                  to.
                </p>
                <Table
                  headers={[
                    "Member State",
                    "Quarter corrected",
                    "Taxable",
                    "VAT",
                  ]}
                >
                  {data.corrections.map((fix) => (
                    <Row key={`${fix.memberState}-${fix.period}`}>
                      <td className="py-2">{fix.memberState}</td>
                      <td
                        style={
                          fix.withinThreeYears
                            ? undefined
                            : { color: "var(--text-danger)" }
                        }
                        title={
                          fix.withinThreeYears
                            ? "Inside the three years a correction is accepted for"
                            : "More than three years after that return was due — the member state has to be approached directly"
                        }
                      >
                        {fix.period}
                        {fix.withinThreeYears ? "" : " — too old to correct"}
                      </td>
                      <td className="whitespace-nowrap">
                        {formatMoney(fix.taxableCents, "EUR")}
                      </td>
                      <td className="whitespace-nowrap">
                        {formatMoney(fix.vatCents, "EUR")}
                      </td>
                    </Row>
                  ))}
                </Table>
              </div>
            ) : null}

            <p className="mt-3 font-medium">
              Total VAT due: {formatMoney(data.totalVatCents, "EUR")}
              <span className="ml-2 text-sm font-normal" style={muted}>
                on {formatMoney(data.totalTaxableCents, "EUR")} of supplies
              </span>
            </p>

            <ul
              className="mt-3 flex flex-col gap-(--gap-tight) text-xs"
              style={muted}
            >
              {data.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          </>
        ) : null}
      </Card>
    </div>
  );
}

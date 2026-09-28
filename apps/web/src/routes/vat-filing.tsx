import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { hmrcClientContext } from "../lib/hmrc-client";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  Row,
  SectionHeading,
  Select,
  Table,
  Toolbar,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * Filing a VAT return to HMRC.
 *
 * A VAT return is a legal declaration. The person pressing the button is
 * confirming the figures are true and complete, they are liable for it, and it
 * **cannot be withdrawn**. So this screen is deliberately slower than it could
 * be: the figures are shown before anything can be sent, the declaration is a
 * separate act, and the wording is HMRC's rather than a cheerful paraphrase.
 */
type Status = {
  available: boolean;
  connected: boolean;
  vrn: string | null;
  sandbox: boolean;
  connectedAt: string | null;
};

type Obligation = {
  periodKey: string;
  start: string;
  end: string;
  due: string;
  status: string;
};

type VatScheme = {
  scheme: "standard" | "flat-rate";
  flatRatePpm: number | null;
  basis: "accrual" | "cash";
};

/**
 * Which VAT scheme the return is computed under.
 *
 * Both schemes are elections a business makes with HMRC, so this asks rather
 * than infers — and the flat rate sector percentage in particular is typed in
 * from HMRC's table, because choosing the sector is the business's own call.
 */
function SchemeCard({
  current,
  onSaved,
}: {
  current: VatScheme;
  onSaved: () => void;
}) {
  const [scheme, setScheme] = useState<VatScheme["scheme"]>(current.scheme);
  const [basis, setBasis] = useState<VatScheme["basis"]>(current.basis);
  const [percent, setPercent] = useState(
    current.flatRatePpm === null ? "" : String(current.flatRatePpm / 10_000),
  );

  const save = useMutation({
    mutationFn: () =>
      api("/api/accounting/vat-scheme", {
        method: "PUT",
        body: JSON.stringify({
          scheme,
          basis,
          // Entered as a percentage, carried in millionths: 14.5% is 145000.
          flatRatePpm:
            scheme === "flat-rate"
              ? Math.round(Number.parseFloat(percent) * 10_000)
              : null,
        }),
      }),
    onSuccess: onSaved,
  });

  return (
    <Card className="flex flex-col gap-(--gap-toolbar)">
      <div>
        <SectionHeading>Your VAT scheme</SectionHeading>
        <p className="text-sm" style={muted}>
          Set this to match what you have agreed with HMRC — the scheme you are
          on is your election, not something the software can work out.
        </p>
      </div>
      <Toolbar>
        <Field label="Scheme">
          <Select
            value={scheme}
            onChange={(e) =>
              setScheme(e.currentTarget.value as VatScheme["scheme"])
            }
          >
            <option value="standard">Standard</option>
            <option value="flat-rate">Flat Rate Scheme</option>
          </Select>
        </Field>
        <Field label="VAT counts when">
          <Select
            value={basis}
            onChange={(e) =>
              setBasis(e.currentTarget.value as VatScheme["basis"])
            }
          >
            <option value="accrual">The invoice is raised</option>
            <option value="cash">The money moves (cash accounting)</option>
          </Select>
        </Field>
        {scheme === "flat-rate" ? (
          <Field
            label="Your sector's flat rate, %"
            hint="From HMRC's sector table — your accountant will know it."
          >
            <Input
              value={percent}
              placeholder="14.5"
              onChange={(e) => setPercent(e.currentTarget.value)}
            />
          </Field>
        ) : null}
        <Button
          needs={{ bookkeeping: ["update"] }}
          onClick={() => save.mutate()}
          disabled={
            save.isPending ||
            (scheme === "flat-rate" &&
              !Number.isFinite(Number.parseFloat(percent)))
          }
        >
          Save
        </Button>
      </Toolbar>
      <p className="text-xs" style={muted}>
        Eligibility, per gov.uk (checked 15 September 2026): the Flat Rate
        Scheme is open under £150,000 of annual turnover excluding VAT and must
        be left above £230,000 including VAT — and a limited cost business pays
        16.5% regardless of sector. Cash accounting is open up to £1.35 million
        and must be left above £1.6 million. Whether either applies to you is
        between you and HMRC.
      </p>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

export function VatFiling() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [vrn, setVrn] = useState("");
  const [chosen, setChosen] = useState<Obligation | null>(null);
  const [declared, setDeclared] = useState(false);

  const status = useQuery({
    queryKey: ["mtd"],
    queryFn: () => api<Status>("/api/accounting/mtd"),
  });

  const scheme = useQuery({
    queryKey: ["vat-scheme"],
    queryFn: () => api<VatScheme>("/api/accounting/vat-scheme"),
  });

  const authorise = useMutation({
    mutationFn: () =>
      api<{ url: string }>("/api/accounting/mtd/authorise", { method: "POST" }),
    onSuccess: (data) => window.open(data.url, "_blank", "noopener"),
  });

  const finish = useMutation({
    mutationFn: () =>
      api("/api/accounting/mtd/finish", {
        method: "POST",
        body: JSON.stringify({ code: code.trim(), vrn: vrn.trim() }),
      }),
    onSuccess: () => {
      setCode("");
      qc.invalidateQueries({ queryKey: ["mtd"] });
    },
  });

  /**
   * Forgetting the connection.
   *
   * Worth having for its own sake: a business selling up, changing accountant,
   * or simply uneasy about a stored authorisation should be able to end it from
   * here rather than only from HMRC's side. It removes the tokens and nothing
   * else — the returns already filed are HMRC's records now.
   */
  const disconnect = useMutation({
    mutationFn: () => api("/api/accounting/mtd", { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mtd"] }),
  });

  const obligations = useMutation({
    mutationFn: () =>
      api<{ obligations: Obligation[] }>("/api/accounting/mtd/obligations", {
        method: "POST",
        body: JSON.stringify({ client: hmrcClientContext() }),
      }),
  });

  /** The figures for the period HMRC named, computed from the books. */
  const preview = useQuery({
    queryKey: ["vat-return", chosen?.start, chosen?.end],
    enabled: Boolean(chosen),
    queryFn: () =>
      api<{ boxes: Record<string, number>; notCovered: string[] }>(
        `/api/accounting/vat-return?from=${chosen?.start}&to=${chosen?.end}`,
      ),
  });

  const submit = useMutation({
    mutationFn: () =>
      api<{ receipt: { formBundleNumber: string; processingDate: string } }>(
        "/api/accounting/mtd/submit",
        {
          method: "POST",
          body: JSON.stringify({
            periodKey: chosen?.periodKey,
            from: chosen?.start,
            to: chosen?.end,
            finalised: true,
            client: hmrcClientContext(),
          }),
        },
      ),
    onSuccess: () => {
      setChosen(null);
      setDeclared(false);
      obligations.mutate();
    },
  });

  if (status.isLoading) return <Loading />;

  /*
   * Said rather than shown as a dead button. An instance without HMRC
   * credentials cannot file, and a business pressing a button that does nothing
   * is worse off than one told so.
   */
  if (!status.data?.available) {
    return (
      <Page>
        <Card>
          <SectionHeading>Filing to HMRC is not set up here</SectionHeading>
          <p className="text-sm" style={muted}>
            This instance has no HMRC credentials configured, so it cannot file
            a VAT return. You can still see the return itself under Reports.
          </p>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      {status.data.sandbox ? (
        /*
         * Impossible to miss, and it should be. A business that thinks it has
         * filed when it has filed into a test system will find out from a
         * penalty notice.
         */
        <Card>
          <p
            className="text-sm font-medium"
            style={{ color: "var(--text-warning)" }}
          >
            Test mode — nothing filed here reaches HMRC's real systems
          </p>
          <p className="text-sm" style={muted}>
            Returns submitted go to HMRC's sandbox. Your actual VAT obligations
            are unaffected and still need filing.
          </p>
        </Card>
      ) : null}

      {scheme.data ? (
        <SchemeCard
          // Re-seeded if another session changes the election underneath us.
          key={`${scheme.data.scheme}-${scheme.data.basis}-${scheme.data.flatRatePpm}`}
          current={scheme.data}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["vat-scheme"] });
            // The boxes are a different arithmetic now; recompute what is shown.
            qc.invalidateQueries({ queryKey: ["vat-return"] });
          }}
        />
      ) : null}

      <Card className="flex flex-col gap-(--gap-toolbar)">
        <div>
          <SectionHeading>Your HMRC connection</SectionHeading>
          <p className="text-sm" style={muted}>
            {status.data.connected
              ? `Connected for VAT number ${status.data.vrn}.`
              : "Authorise this instance to file on your behalf. You will sign in at HMRC and copy a code back here — the code and the connection stay on this server."}
          </p>
        </div>

        {status.data.connected ? (
          <Toolbar>
            <Button
              variant="secondary"
              onClick={() => obligations.mutate()}
              disabled={obligations.isPending}
            >
              {obligations.isPending ? "Asking HMRC…" : "What is due?"}
            </Button>
            <Button
              variant="secondary"
              needs={{ bookkeeping: ["update"] }}
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              Disconnect
            </Button>
          </Toolbar>
        ) : (
          <>
            <Button
              needs={{ bookkeeping: ["update"] }}
              onClick={() => authorise.mutate()}
              disabled={authorise.isPending}
            >
              Sign in at HMRC
            </Button>
            <Toolbar>
              <Field
                label="Your VAT number"
                hint="Nine digits. Filing against the wrong one cannot be undone."
              >
                <Input
                  value={vrn}
                  placeholder="123456789"
                  onChange={(e) => setVrn(e.currentTarget.value)}
                />
              </Field>
              <Field
                label="The code HMRC showed you"
                hint="It expires after a few minutes — paste it straight away."
              >
                <Input
                  value={code}
                  onChange={(e) => setCode(e.currentTarget.value)}
                />
              </Field>
              <Button
                needs={{ bookkeeping: ["update"] }}
                disabled={!code.trim() || !vrn.trim() || finish.isPending}
                onClick={() => finish.mutate()}
              >
                Connect
              </Button>
            </Toolbar>
          </>
        )}
        {authorise.error ? <ErrorNote error={authorise.error} /> : null}
        {finish.error ? <ErrorNote error={finish.error} /> : null}
        {obligations.error ? <ErrorNote error={obligations.error} /> : null}
        {disconnect.error ? <ErrorNote error={disconnect.error} /> : null}
      </Card>

      {obligations.data ? (
        <Card>
          <SectionHeading>What HMRC says is due</SectionHeading>
          {obligations.data.obligations.length === 0 ? (
            <Empty title="Nothing due in this window">
              HMRC has no open or filed obligations for these dates. Widen the
              dates if a period you expected is outside them.
            </Empty>
          ) : null}
          <Table headers={["Period", "Due", "Status", ""]}>
            {obligations.data.obligations.map((o) => (
              <Row key={o.periodKey}>
                <td>
                  {o.start} to {o.end}
                </td>
                <td>{o.due}</td>
                <td>{o.status === "O" ? "Open" : "Filed"}</td>
                <td className="text-right">
                  {o.status === "O" ? (
                    <Button variant="secondary" onClick={() => setChosen(o)}>
                      Prepare it
                    </Button>
                  ) : (
                    <span style={muted}>done</span>
                  )}
                </td>
              </Row>
            ))}
          </Table>
        </Card>
      ) : null}

      {chosen ? (
        <Card className="flex flex-col gap-(--gap-toolbar)">
          <SectionHeading>
            The return for {chosen.start} to {chosen.end}
          </SectionHeading>
          {preview.isLoading ? <Loading /> : null}
          {preview.error ? <ErrorNote error={preview.error} /> : null}
          {preview.data ? (
            <>
              <Table
                headers={[
                  "Box",
                  "What it is",
                  { label: "Amount", money: true },
                ]}
              >
                {[
                  ["1", "VAT due on sales", "vatDueSales"],
                  ["2", "VAT due on EU acquisitions", "vatDueAcquisitions"],
                  ["3", "Total VAT due", "totalVatDue"],
                  ["4", "VAT reclaimed on purchases", "vatReclaimedCurrPeriod"],
                  ["5", "Net VAT to pay or reclaim", "netVatDue"],
                  ["6", "Total sales, excluding VAT", "totalValueSalesExVAT"],
                  [
                    "7",
                    "Total purchases, excluding VAT",
                    "totalValuePurchasesExVAT",
                  ],
                  ["8", "Supplies to the EU", "totalValueGoodsSuppliedExVAT"],
                  ["9", "Acquisitions from the EU", "totalAcquisitionsExVAT"],
                ].map(([box, label, key]) => (
                  <Row key={String(box)}>
                    <td style={muted}>{box}</td>
                    <td>{label}</td>
                    <td className="money">
                      {formatMoney(preview.data?.boxes[String(key)] ?? 0)}
                    </td>
                  </Row>
                ))}
              </Table>

              {preview.data.notCovered.map((note) => (
                <p key={note} className="text-xs" style={muted}>
                  {note}
                </p>
              ))}

              {/*
                HMRC's own wording, not a paraphrase. The person is making a
                declaration they are liable for, and softening it would be
                doing them a disservice on the one screen where the words are
                the product.
              */}
              <label className="flex items-start gap-(--gap-toolbar) text-sm">
                <input
                  type="checkbox"
                  className="mt-(--gap-tight)"
                  checked={declared}
                  onChange={(e) => setDeclared(e.target.checked)}
                />
                <span>
                  When you submit this VAT information you are making a legal
                  declaration that the information is true and complete. A false
                  declaration can result in prosecution.
                </span>
              </label>

              <Toolbar>
                <Button
                  variant="danger"
                  needs={{ bookkeeping: ["update"] }}
                  disabled={!declared || submit.isPending}
                  onClick={() => submit.mutate()}
                >
                  {submit.isPending ? "Filing…" : "File this return"}
                </Button>
                <Button variant="secondary" onClick={() => setChosen(null)}>
                  Not yet
                </Button>
              </Toolbar>
              <p className="text-xs" style={muted}>
                A filed return cannot be withdrawn. Corrections are made on a
                later return, or by contacting HMRC.
              </p>
              {submit.error ? <ErrorNote error={submit.error} /> : null}
            </>
          ) : null}
        </Card>
      ) : null}

      {submit.data ? (
        <Card>
          <SectionHeading>Filed</SectionHeading>
          <p className="text-sm" style={muted}>
            HMRC's receipt number is{" "}
            <strong>{submit.data.receipt.formBundleNumber}</strong>, at{" "}
            {new Date(submit.data.receipt.processingDate).toLocaleString()}.
            Keep it — it is what HMRC asks for if there is ever a question about
            this return.
          </p>
        </Card>
      ) : null}
    </Page>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { hmrcClientContext } from "../lib/hmrc-client";
import {
  Button,
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
        `/api/reports/vat-return?from=${chosen?.start}&to=${chosen?.end}`,
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
      <Card>
        <p className="text-sm font-medium">Filing to HMRC is not set up here</p>
        <p className="text-sm" style={muted}>
          This instance has no HMRC credentials configured, so it cannot file a
          VAT return. You can still see the return itself under Reports.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {status.data.sandbox ? (
        /*
         * Impossible to miss, and it should be. A business that thinks it has
         * filed when it has filed into a test system will find out from a
         * penalty notice.
         */
        <Card>
          <p
            className="text-sm font-medium"
            style={{ color: "var(--color-warning)" }}
          >
            Test mode — nothing filed here reaches HMRC's real systems
          </p>
          <p className="text-sm" style={muted}>
            Returns submitted go to HMRC's sandbox. Your actual VAT obligations
            are unaffected and still need filing.
          </p>
        </Card>
      ) : null}

      <Card className="space-y-3">
        <div>
          <p className="text-sm font-medium">Your HMRC connection</p>
          <p className="text-sm" style={muted}>
            {status.data.connected
              ? `Connected for VAT number ${status.data.vrn}.`
              : "Authorise this instance to file on your behalf. You will sign in at HMRC and copy a code back here — the code and the connection stay on this server."}
          </p>
        </div>

        {status.data.connected ? (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => obligations.mutate()}
              disabled={obligations.isPending}
            >
              {obligations.isPending ? "Asking HMRC…" : "What is due?"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <>
            <Button
              onClick={() => authorise.mutate()}
              disabled={authorise.isPending}
            >
              Sign in at HMRC
            </Button>
            <div className="flex flex-wrap items-end gap-3">
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
                disabled={!code.trim() || !vrn.trim() || finish.isPending}
                onClick={() => finish.mutate()}
              >
                Connect
              </Button>
            </div>
          </>
        )}
        {authorise.error ? <ErrorNote error={authorise.error} /> : null}
        {finish.error ? <ErrorNote error={finish.error} /> : null}
        {obligations.error ? <ErrorNote error={obligations.error} /> : null}
        {disconnect.error ? <ErrorNote error={disconnect.error} /> : null}
      </Card>

      {obligations.data ? (
        <Card>
          <p className="mb-2 text-sm font-medium">What HMRC says is due</p>
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
        <Card className="space-y-3">
          <p className="text-sm font-medium">
            The return for {chosen.start} to {chosen.end}
          </p>
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
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={declared}
                  onChange={(e) => setDeclared(e.target.checked)}
                />
                <span>
                  When you submit this VAT information you are making a legal
                  declaration that the information is true and complete. A false
                  declaration can result in prosecution.
                </span>
              </label>

              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={!declared || submit.isPending}
                  onClick={() => submit.mutate()}
                >
                  {submit.isPending ? "Filing…" : "File this return"}
                </Button>
                <Button variant="secondary" onClick={() => setChosen(null)}>
                  Not yet
                </Button>
              </div>
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
          <p className="text-sm font-medium">Filed</p>
          <p className="text-sm" style={muted}>
            HMRC's receipt number is{" "}
            <strong>{submit.data.receipt.formBundleNumber}</strong>, at{" "}
            {new Date(submit.data.receipt.processingDate).toLocaleString()}.
            Keep it — it is what HMRC asks for if there is ever a question about
            this return.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

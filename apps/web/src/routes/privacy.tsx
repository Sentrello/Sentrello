import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  muted,
} from "../lib/ui";

/**
 * Answering somebody who asks about their own data.
 *
 * GDPR gives a month to say what is held about a person, to hand it over in a
 * portable form, and to erase it. The CCPA gives forty-five days for the same
 * questions. Those deadlines are why this is a screen: a business of nine
 * people will not meet a month by hand across six modules, and until now there
 * was no way to do it at all — the Shop module could export its own records,
 * the Links module could forget an address, and the CRM, where a contact record
 * *is* a person, could do neither.
 *
 * Every module that holds personal data says so. This asks all of them at once,
 * because the person asking does not know one module from another.
 */

type Source = {
  id: string;
  module: string;
  label: string;
  retention: string;
  canErase: boolean;
};

type ExportResult = {
  subject: string;
  answeredAt: string;
  total: number;
  sources: {
    source: string;
    label: string;
    records: { kind: string; reference?: string; data: unknown }[];
    error?: string;
  }[];
};

type EraseResult = {
  subject: string;
  sources: {
    source: string;
    label: string;
    removed: string[];
    kept: { what: string; why: string }[];
    error?: string;
  }[];
};

/**
 * The compliance half of this screen: HIPAA safeguards, and the evidence an
 * auditor asks for.
 *
 * Beside the subject-request tools rather than on a page of its own, because
 * they are the same job — a business that has to answer a regulator has to
 * answer all of them, and hunting across three screens is how one gets missed.
 */
function Safeguards() {
  const qc = useQueryClient();
  const compliance = useQuery({
    queryKey: ["compliance"],
    queryFn: () =>
      api<{
        settings: {
          hipaa: boolean;
          idleTimeoutMinutes: number;
          logReads: boolean;
          requireTwoFactor: boolean;
          riskAssessmentOn: string | null;
        };
        yourOwnObligations: {
          what: string;
          rule: string;
          why: string;
          done: boolean | null;
        }[];
      }>("/api/compliance"),
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api("/api/compliance", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["compliance"] }),
  });

  const evidence = useMutation({
    mutationFn: () => api<unknown>("/api/compliance/evidence"),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-evidence-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const on = compliance.data?.settings.hipaa ?? false;

  return (
    <>
      <Card className="space-y-3">
        <div>
          <p className="text-sm font-medium">HIPAA safeguards</p>
          <p className="text-sm" style={muted}>
            For a medical practice or anyone else handling health information.
            Turning this on applies the technical safeguards the Security Rule
            asks for. It does not make a business HIPAA compliant — that is a
            programme you run, and the list below is the part no software can do
            for you.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={on}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ hipaa: e.target.checked })}
          />
          Apply HIPAA safeguards to this business
        </label>

        {on && compliance.data ? (
          <div className="space-y-2 pt-1">
            <Field
              label="Sign out after"
              hint="Minutes of inactivity. The screen left open in a room patients walk through is the reason for this one."
            >
              <Input
                type="number"
                min={1}
                max={60}
                style={{ width: "6rem" }}
                value={String(compliance.data.settings.idleTimeoutMinutes)}
                onChange={(e) =>
                  save.mutate({
                    idleTimeoutMinutes: Number(e.currentTarget.value),
                  })
                }
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={compliance.data.settings.requireTwoFactor}
                onChange={(e) =>
                  save.mutate({ requireTwoFactor: e.target.checked })
                }
              />
              Require a second factor from everybody
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={compliance.data.settings.logReads}
                onChange={(e) => save.mutate({ logReads: e.target.checked })}
              />
              Record every time somebody opens a patient's record
            </label>
            <Field
              label="Your risk assessment was completed on"
              hint="Nothing enforces this. It is asked because the commonest audit finding in a small practice is that nobody can produce a date."
            >
              <Input
                type="date"
                value={
                  compliance.data.settings.riskAssessmentOn?.slice(0, 10) ?? ""
                }
                onChange={(e) =>
                  save.mutate({ riskAssessmentOn: e.currentTarget.value })
                }
              />
            </Field>
          </div>
        ) : null}

        {save.error ? <ErrorNote error={save.error} /> : null}

        {on && compliance.data ? (
          <div className="pt-2">
            <p className="text-sm font-medium">What is still yours to do</p>
            {compliance.data.yourOwnObligations.map((o) => (
              <div key={o.what} className="mt-2">
                <p className="text-sm">
                  {o.done === true ? "✓ " : ""}
                  {o.what} <span style={muted}>({o.rule})</span>
                </p>
                <p className="text-sm" style={muted}>
                  {o.why}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <Card className="space-y-2">
        <p className="text-sm font-medium">Evidence for an audit</p>
        <p className="text-sm" style={muted}>
          For a SOC 2 audit, ISO 27001, or a large customer's security
          questionnaire: who has access and at what level, every change to that
          access, what personal data is held and for how long. It also names the
          four things an auditor will ask for that this software cannot see.
        </p>
        <div>
          <Button
            variant="secondary"
            disabled={evidence.isPending}
            onClick={() => evidence.mutate()}
          >
            {evidence.isPending ? "Gathering…" : "Download the evidence pack"}
          </Button>
        </div>
        {evidence.error ? <ErrorNote error={evidence.error} /> : null}
      </Card>
    </>
  );
}

export function Privacy() {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);

  const sources = useQuery({
    queryKey: ["privacy", "sources"],
    queryFn: () => api<{ sources: Source[] }>("/api/privacy/sources"),
  });

  const requests = useQuery({
    queryKey: ["privacy", "requests"],
    queryFn: () =>
      api<{
        requests: {
          id: string;
          action: string;
          subjectName: string | null;
          at: string;
        }[];
      }>("/api/privacy/requests"),
  });

  const gather = useMutation({
    mutationFn: () =>
      api<ExportResult>("/api/privacy/export", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      }),
  });

  const erase = useMutation({
    mutationFn: () =>
      api<EraseResult>("/api/privacy/erase", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), note: note.trim() }),
      }),
    onSuccess: () => {
      setConfirming(false);
      setNote("");
      requests.refetch();
    },
  });

  /**
   * The export offered as a file, because "portable form" is the actual
   * wording of the right and a table on a screen is not portable.
   */
  const download = () => {
    if (!gather.data) return;
    const blob = new Blob([JSON.stringify(gather.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `personal-data-${gather.data.subject.replace(/[^a-z0-9]+/gi, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div>
          <p className="text-sm font-medium">
            Somebody asking about their data
          </p>
          <p className="text-sm" style={muted}>
            Find everything this business holds about one person, hand it to
            them, or erase it. You have a month to answer under UK and EU law,
            and forty-five days under California's.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Their email">
            <Input
              value={email}
              placeholder="someone@example.com"
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </Field>
          <Button
            disabled={!email.trim() || gather.isPending}
            onClick={() => gather.mutate()}
          >
            {gather.isPending ? "Looking…" : "Find what we hold"}
          </Button>
        </div>
        {gather.error ? <ErrorNote error={gather.error} /> : null}
      </Card>

      {gather.data ? (
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {gather.data.total} record
              {gather.data.total === 1 ? "" : "s"} about {gather.data.subject}
            </p>
            {gather.data.total > 0 ? (
              <Button variant="secondary" onClick={download}>
                Download it for them
              </Button>
            ) : null}
          </div>

          {gather.data.sources.map((s) => (
            <div key={s.source}>
              <p className="text-sm font-medium">{s.label}</p>
              {s.error ? (
                /*
                 * Said out loud rather than swallowed. An export that quietly
                 * omits a module is a legal answer that is wrong, and the
                 * business needs to know which part did not answer before they
                 * send it.
                 */
                <p
                  className="text-sm"
                  style={{ color: "var(--danger, #b91c1c)" }}
                >
                  This did not answer: {s.error}. Do not send this export until
                  it does.
                </p>
              ) : s.records.length === 0 ? (
                <p className="text-sm" style={muted}>
                  Nothing held.
                </p>
              ) : (
                <ul className="text-sm" style={muted}>
                  {s.records.map((r, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a list of findings, not entities
                    <li key={i}>
                      {r.kind}
                      {r.reference ? ` — ${r.reference}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          {gather.data.total > 0 ? (
            <div className="pt-2">
              {confirming ? (
                <div className="space-y-2">
                  <Field
                    label="How did you check this is really them?"
                    hint="Kept with the record of the erasure. It is what you will be asked about afterwards."
                  >
                    <Input
                      value={note}
                      placeholder="Replied from the address on file, confirmed the last order number"
                      onChange={(e) => setNote(e.currentTarget.value)}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      disabled={!note.trim() || erase.isPending}
                      onClick={() => erase.mutate()}
                    >
                      Erase them
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setConfirming(true)}>
                  Erase what can be erased
                </Button>
              )}
              {erase.error ? <ErrorNote error={erase.error} /> : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {erase.data ? (
        <Card className="space-y-2">
          <p className="text-sm font-medium">What was done</p>
          {erase.data.sources.map((s) => (
            <div key={s.source}>
              <p className="text-sm">{s.label}</p>
              {s.removed.length ? (
                <p className="text-sm" style={muted}>
                  Removed: {s.removed.join(", ")}.
                </p>
              ) : null}
              {s.kept.map((k) => (
                <p key={k.what} className="text-sm" style={muted}>
                  Kept: {k.what} — {k.why}.
                </p>
              ))}
              {s.error ? <ErrorNote error={s.error} /> : null}
            </div>
          ))}
          <p className="text-sm" style={muted}>
            Tell them what was kept and why. Saying "everything is gone" when an
            invoice remains is a false statement, and keeping it is lawful.
          </p>
        </Card>
      ) : null}

      <Card className="space-y-2">
        <p className="text-sm font-medium">
          What this business holds, and for how long
        </p>
        <p className="text-sm" style={muted}>
          Assembled from the modules installed here rather than from a document
          somebody wrote once. This is what to copy into a privacy notice.
        </p>
        {sources.isLoading ? (
          <Loading />
        ) : (
          (sources.data?.sources ?? []).map((s) => (
            <div key={s.id}>
              <p className="text-sm">
                {s.label}{" "}
                <span style={muted}>
                  ({s.canErase ? "can be erased" : "kept by law"})
                </span>
              </p>
              <p className="text-sm" style={muted}>
                {s.retention}
              </p>
            </div>
          ))
        )}
      </Card>

      <Safeguards />

      <Card className="space-y-2">
        <p className="text-sm font-medium">Requests you have answered</p>
        {requests.data?.requests.length ? (
          <ul className="text-sm" style={muted}>
            {requests.data.requests.map((r) => (
              <li key={r.id}>
                {new Date(r.at).toLocaleDateString()} —{" "}
                {r.action === "privacy.erased" ? "erased" : "exported"}{" "}
                {r.subjectName ?? ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={muted}>
            None yet. Every export and erasure is recorded here.
          </p>
        )}
      </Card>
    </div>
  );
}

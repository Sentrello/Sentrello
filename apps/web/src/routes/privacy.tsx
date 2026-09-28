import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, may } from "../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  SectionHeading,
  Toolbar,
  Warning,
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
/**
 * Said once for the three writes on this screen.
 *
 * They are checkboxes and a date, not buttons, so `needs` has nothing to sit
 * on — the kit has no checkbox and this is the only screen with one that
 * writes. The wording matches what the kit puts on a blocked control, because
 * somebody meeting both should not have to work out that they are the same
 * thing.
 */
const REFUSED = "Your role does not allow this.";

function Safeguards() {
  const qc = useQueryClient();
  const maySave = may("settings", "update");
  const compliance = useQuery({
    queryKey: ["compliance"],
    queryFn: () =>
      api<{
        settings: {
          regimes: string[];
          hipaa: boolean;
          idleTimeoutMinutes: number;
          logReads: boolean;
          requireTwoFactor: boolean;
          riskAssessmentOn: string | null;
        };
        regimes: {
          id: string;
          label: string;
          where: string;
          when: string;
          turnsOn: string[];
          chosen: boolean;
        }[];
        yourOwnObligations: {
          regime: string;
          what: string;
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
  const regimes = compliance.data?.regimes ?? [];

  /** Chosen ones plus or minus one, sent as the whole list. */
  const toggle = (id: string, wanted: boolean) =>
    save.mutate({
      regimes: regimes
        .filter((r) => (r.id === id ? wanted : r.chosen))
        .map((r) => r.id),
    });

  return (
    <>
      <Card className="flex flex-col gap-(--gap-toolbar)">
        <div>
          <SectionHeading>What applies to this business</SectionHeading>
          <p className="text-sm" style={muted}>
            Compliance works like modules here: you switch on what applies to
            you. A t-shirt shop in Texas and the same shop in Berlin are the
            same software and not the same obligations. Change these whenever
            the business changes — none of it is a one-way door.
          </p>
        </div>

        {/*
          One note for the card, above the list it speaks for.

          A fetch that failed has no regimes either, so this drew the heading
          with nothing under it: no ticks, no safeguards, no obligations — a
          business told, in effect, that none of this applies to it and that
          nothing is switched on. On a compliance screen that is the one
          wrong answer nobody checks, because it is the answer they hoped for.
        */}
        {compliance.error ? <ErrorNote error={compliance.error} /> : null}

        {regimes.map((r) => (
          <div key={r.id} className="pb-(--gap-toolbar)">
            <label className="flex items-start gap-(--gap-toolbar) text-sm">
              <input
                type="checkbox"
                className="mt-(--gap-tight)"
                checked={r.chosen}
                disabled={save.isPending}
                onChange={(e) => toggle(r.id, e.target.checked)}
              />
              <span>
                {r.label}
                <span className="block" style={muted}>
                  {r.when}
                </span>
                {r.chosen && r.turnsOn.length ? (
                  <span className="mt-(--gap-tight) block" style={muted}>
                    Turns on: {r.turnsOn.join("; ")}.
                  </span>
                ) : null}
              </span>
            </label>
          </div>
        ))}

        {on && compliance.data ? (
          <div className="flex flex-col gap-(--gap-toolbar) pt-(--gap-tight)">
            <Field
              label="Sign out after"
              hint="Minutes of inactivity. The screen left open in a room patients walk through is the reason for this one."
            >
              <Input
                needs={{ settings: ["update"] }}
                type="number"
                min={1}
                max={60}
                className="w-24"
                value={String(compliance.data.settings.idleTimeoutMinutes)}
                onChange={(e) =>
                  save.mutate({
                    idleTimeoutMinutes: Number(e.currentTarget.value),
                  })
                }
              />
            </Field>
            <label className="flex items-center gap-(--gap-toolbar) text-sm">
              <input
                type="checkbox"
                checked={compliance.data.settings.requireTwoFactor}
                disabled={!maySave}
                title={maySave ? undefined : REFUSED}
                onChange={(e) =>
                  save.mutate({ requireTwoFactor: e.target.checked })
                }
              />
              Require a second factor from everybody
            </label>
            <label className="flex items-center gap-(--gap-toolbar) text-sm">
              {/* A checkbox whose change is the write, so it is gated the
                  same as a button would be. No primitive for it: the kit has
                  no checkbox, and one exists on exactly this screen. */}
              <input
                type="checkbox"
                checked={compliance.data.settings.logReads}
                disabled={!maySave}
                title={maySave ? undefined : REFUSED}
                onChange={(e) => save.mutate({ logReads: e.target.checked })}
              />
              Record every time somebody opens a patient's record
            </label>
            <Field
              label="Your risk assessment was completed on"
              hint="Nothing enforces this. It is asked because the commonest audit finding in a small practice is that nobody can produce a date."
            >
              <Input
                needs={{ settings: ["update"] }}
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

        {compliance.data?.yourOwnObligations.length ? (
          <div className="pt-(--gap-toolbar)">
            <SectionHeading level={3}>What is still yours to do</SectionHeading>
            {compliance.data.yourOwnObligations.map((o) => (
              <div key={o.what} className="mt-(--gap-toolbar)">
                <p className="text-sm">
                  {o.done === true ? "✓ " : ""}
                  {o.what} <span style={muted}>({o.regime})</span>
                </p>
                <p className="text-sm" style={muted}>
                  {o.why}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-(--gap-toolbar)">
        <div>
          <SectionHeading>Evidence for an audit</SectionHeading>
          <p className="text-sm" style={muted}>
            For a SOC 2 audit, ISO 27001, or a large customer's security
            questionnaire: who has access and at what level, every change to
            that access, what personal data is held and for how long. It also
            names the four things an auditor will ask for that this software
            cannot see.
          </p>
        </div>
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
    <Page width="prose">
      <Card className="flex flex-col gap-(--gap-toolbar)">
        <div>
          <SectionHeading>Somebody asking about their data</SectionHeading>
          <p className="text-sm" style={muted}>
            Find everything this business holds about one person, hand it to
            them, or erase it. You have a month to answer under UK and EU law,
            and forty-five days under California's.
          </p>
        </div>
        <Toolbar>
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
        </Toolbar>
        {gather.error ? <ErrorNote error={gather.error} /> : null}
      </Card>

      {gather.data ? (
        <Card className="flex flex-col gap-(--gap-toolbar)">
          <SectionHeading
            trailing={
              gather.data.total > 0 ? (
                <Button variant="secondary" onClick={download}>
                  Download it for them
                </Button>
              ) : null
            }
          >
            {gather.data.total} record
            {gather.data.total === 1 ? "" : "s"} about {gather.data.subject}
          </SectionHeading>

          {gather.data.sources.map((s) => (
            <div key={s.source}>
              <SectionHeading level={3}>{s.label}</SectionHeading>
              {s.error ? (
                /*
                 * Said out loud rather than swallowed. An export that quietly
                 * omits a module is a legal answer that is wrong, and the
                 * business needs to know which part did not answer before they
                 * send it.
                 */
                <Warning>
                  This did not answer: {s.error}. Do not send this export until
                  it does.
                </Warning>
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
            <div className="pt-(--gap-toolbar)">
              {confirming ? (
                <div className="flex flex-col gap-(--gap-toolbar)">
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
                  <Toolbar>
                    <Button
                      variant="danger"
                      needs={{ settings: ["update"] }}
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
                  </Toolbar>
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
        <Card className="flex flex-col gap-(--gap-toolbar)">
          <SectionHeading>What was done</SectionHeading>
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
              {s.error ? (
                /*
                 * Said out loud, the way the export above says it.
                 *
                 * This was `<ErrorNote error={s.error} />`, and `s.error` is a
                 * plain string where `ErrorNote` reads `serverMessage` off an
                 * object — so it fell through to "Something went wrong." On
                 * the one screen where a business has to be able to say which
                 * module refused to erase somebody and why, it said nothing.
                 *
                 * The consequence is not a worse error message. It is telling
                 * a data subject their record is gone when a module still
                 * holds it, and having no way to know which.
                 */
                <Warning>
                  This did not erase: {s.error}. They still hold something, so
                  do not tell anybody it is gone.
                </Warning>
              ) : null}
            </div>
          ))}
          <p className="text-sm" style={muted}>
            Tell them what was kept and why. Saying "everything is gone" when an
            invoice remains is a false statement, and keeping it is lawful.
          </p>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-(--gap-toolbar)">
        <div>
          <SectionHeading>
            What this business holds, and for how long
          </SectionHeading>
          <p className="text-sm" style={muted}>
            Assembled from the modules installed here rather than from a
            document somebody wrote once. This is what to copy into a privacy
            notice.
          </p>
        </div>
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

      <Card className="flex flex-col gap-(--gap-toolbar)">
        <SectionHeading>Requests you have answered</SectionHeading>
        {/* "None yet" is only true once the list has arrived. This is the
            record of who was answered and when — the thing a regulator asks
            for — so a fetch that broke must not read as a clean sheet. */}
        {requests.error ? (
          <ErrorNote error={requests.error} />
        ) : requests.data?.requests.length ? (
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
    </Page>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import {
  Button,
  Card,
  ConfirmButton,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  Row,
  SectionHeading,
  Select,
  StatusBadge,
  Table,
  Toolbar,
  formatDate,
  muted,
} from "../lib/ui";

/**
 * Taking old records off this server, without losing them.
 *
 * The screen is arranged in the order the thing actually happens, because the
 * order is the safety: choose what and when, look at what that holds and at
 * anything standing in the way, write the archive, and only then — as a
 * separate, differently-worded decision — remove the local copy. Nothing here
 * offers a one-click "archive and delete" that skips the middle.
 *
 * The refusals are shown as sentences rather than as a disabled button with no
 * explanation. A business told "you cannot delete this" and not told why
 * assumes the product is broken; told "records this recent have to be kept: GB
 * means 6 years", it understands, and often exports a copy anyway — which is
 * the outcome we want and the one the screen makes easiest.
 */

type Blocker = { kind: string; message: string };

type Plan = {
  set: string;
  from: string;
  to: string;
  counts: { table: string; rows: number }[];
  rows: number;
  blockers: Blocker[];
  retention: { years: number; countryCode: string | null; cutoff: string };
};

type Sets = {
  sets: {
    id: string;
    label: string;
    description: string;
    statutory: boolean;
    requiresClosedBooks: boolean;
    carriesForward: boolean;
  }[];
  retention: { years: number; countryCode: string | null; cutoff: string };
};

type Destination = {
  id: string;
  defaultDirectory: string;
  values: Record<string, string>;
  set: string[];
  available: {
    id: string;
    label: string;
    description: string;
    fields: {
      name: string;
      label: string;
      secret?: boolean;
      required?: boolean;
      placeholder?: string;
      help?: string;
    }[];
  }[];
};

type Run = {
  id: string;
  setId: string;
  periodFrom: string;
  periodTo: string;
  filename: string;
  status: string;
  bytes: number;
  sha256: string | null;
  rows: { table: string; rows: number }[];
  removedRows: { table: string; rows: number }[] | null;
  carriedForward: string[];
  error: string | null;
  createdAt: string;
  present: boolean;
};

const size = (bytes: number) => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const thisYear = new Date().getUTCFullYear();

export function Archive() {
  const qc = useQueryClient();
  const [setId, setSetId] = useState("activity");
  const [from, setFrom] = useState(`${thisYear - 8}-01`);
  const [to, setTo] = useState(`${thisYear - 8}-12`);

  const sets = useQuery({
    queryKey: ["archive", "sets"],
    queryFn: () => api<Sets>("/api/archive/sets"),
  });

  const plan = useQuery({
    queryKey: ["archive", "plan", setId, from, to],
    queryFn: () =>
      api<Plan>(
        `/api/archive/plan?set=${encodeURIComponent(setId)}&from=${from}&to=${to}`,
      ),
    retry: false,
  });

  const runs = useQuery({
    queryKey: ["archive", "runs"],
    queryFn: () => api<{ runs: Run[] }>("/api/archive/runs"),
  });

  const write = useMutation({
    mutationFn: (remove: boolean) =>
      api<{ run: Run; removed: unknown }>("/api/archive/runs", {
        method: "POST",
        body: JSON.stringify({ set: setId, from, to, remove }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["archive"] });
    },
  });

  const forget = useMutation({
    mutationFn: (id: string) =>
      api(`/api/archive/runs/${id}/file`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["archive", "runs"] }),
  });

  if (sets.isLoading) return <Loading />;
  if (sets.error) return <ErrorNote error={sets.error} />;

  const chosen = sets.data?.sets.find((s) => s.id === setId);
  const blockers = plan.data?.blockers ?? [];
  const mayRemove = Boolean(plan.data) && blockers.length === 0;

  return (
    <Page>
      <Card>
        <SectionHeading hint="Nothing is removed until the archive has been read back and checked.">
          Archive and offload
        </SectionHeading>
        <p style={muted}>
          This is not a backup. It is one period of one kind of record, taken
          once and removed on purpose — your instance still needs backups.
        </p>
      </Card>

      <Card>
        <SectionHeading>What to archive</SectionHeading>
        <div className="grid gap-(--gap-toolbar) sm:grid-cols-3">
          <Field label="Records">
            <Select value={setId} onChange={(e) => setSetId(e.target.value)}>
              {sets.data?.sets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From (month)">
            <Input
              value={from}
              placeholder="2019-01"
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To (month)">
            <Input
              value={to}
              placeholder="2019-12"
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
        {chosen ? <p style={muted}>{chosen.description}</p> : null}

        {plan.error ? <ErrorNote error={plan.error} /> : null}
        {plan.data ? (
          <>
            <Table headers={["Table", "Records"]}>
              {plan.data.counts.map((count) => (
                <Row key={count.table}>
                  <td>{count.table.replaceAll("_", " ")}</td>
                  <td>{count.rows.toLocaleString()}</td>
                </Row>
              ))}
            </Table>
            {blockers.length > 0 ? (
              <div className="grid gap-(--gap-toolbar)">
                <strong>These records can be copied, but not removed:</strong>
                <ul>
                  {blockers.map((blocker) => (
                    <li key={blocker.message}>{blocker.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <Toolbar className="mt-(--gap-stack)">
              <Button
                needs={{ archive: ["create"] }}
                onClick={() => write.mutate(false)}
                disabled={write.isPending || plan.data.rows === 0}
              >
                {write.isPending ? "Writing…" : "Write a copy, keep everything"}
              </Button>
              <ConfirmButton
                variant="danger"
                danger
                confirmLabel="Remove them"
                title="Remove these records from this server?"
                message={`The archive is written and read back first. If anything about it does not check out, nothing is removed.${
                  chosen?.carriesForward
                    ? " A summary is posted in place of what goes, so your reports over this period do not change."
                    : ""
                }`}
                needs={{ archive: ["create"] }}
                disabled={!mayRemove || write.isPending || plan.data.rows === 0}
                onConfirm={() => write.mutate(true)}
              >
                Archive and remove from this server
              </ConfirmButton>
            </Toolbar>
            {write.error ? <ErrorNote error={write.error} /> : null}
            {write.data ? (
              <p>
                {write.data.removed
                  ? "Written, checked, and the local records removed."
                  : "Written and checked. Everything is still here."}
              </p>
            ) : null}
          </>
        ) : (
          <Loading />
        )}
      </Card>

      <Card>
        <SectionHeading hint="What left, when, and the checksum to compare your copy against.">
          Archives written
        </SectionHeading>
        {runs.data && runs.data.runs.length > 0 ? (
          <Table
            headers={["Period", "Records", "Size", "Status", "Written", ""]}
          >
            {runs.data.runs.map((run) => (
              <Row key={run.id}>
                <td>
                  {run.setId}
                  <div style={muted}>
                    {run.periodFrom.slice(0, 7)} to {run.periodTo.slice(0, 7)}
                  </div>
                </td>
                <td>
                  {run.rows
                    .reduce((total, r) => total + r.rows, 0)
                    .toLocaleString()}
                  {run.removedRows ? (
                    <div style={muted}>removed here</div>
                  ) : null}
                </td>
                <td>{size(run.bytes)}</td>
                <td>
                  <StatusBadge status={run.status} />
                  {run.error ? <div style={muted}>{run.error}</div> : null}
                </td>
                <td>{formatDate(run.createdAt)}</td>
                <td>
                  {run.present ? (
                    <div className="flex gap-(--gap-toolbar)">
                      <a
                        className="link"
                        href={`/api/archive/runs/${run.id}/download`}
                      >
                        Download
                      </a>
                      <ConfirmButton
                        confirmLabel="Clear it"
                        title="Remove the archive file from this server?"
                        message="Only the file. The record of what left, and its checksum, stays. Make sure you have the file somewhere else first."
                        needs={{ archive: ["delete"] }}
                        onConfirm={() => forget.mutate(run.id)}
                      >
                        Clear file
                      </ConfirmButton>
                    </div>
                  ) : (
                    <span style={muted}>not on this server</span>
                  )}
                </td>
              </Row>
            ))}
          </Table>
        ) : (
          <Empty title="Nothing archived yet">
            Archives you write are listed here, with their checksums.
          </Empty>
        )}
        {forget.error ? <ErrorNote error={forget.error} /> : null}
      </Card>

      <Restore />
      <Where />
    </Page>
  );
}

/**
 * Reading one back.
 *
 * Inspect first and restore second, and they are separate buttons: somebody
 * who has found an old zip in a drawer wants to know what is in it before
 * anything is written anywhere.
 */
function Restore() {
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);

  const send = useMutation({
    mutationFn: async (mode: "inspect" | "restore") => {
      const chosen = file.current?.files?.[0];
      if (!chosen) throw new Error("choose an archive file first");
      const form = new FormData();
      form.set("file", chosen);
      form.set("mode", mode);
      const res = await fetch("/api/archive/restore", {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as {
        error?: string;
        inspected?: boolean;
        manifest?: {
          set: string;
          period: { from: string; to: string };
          rows: number;
        };
        counts?: Record<string, number>;
        inserted?: { table: string; rows: number }[];
        skipped?: number;
        summariesRemoved?: number;
        mine?: boolean;
      };
      if (!res.ok)
        throw new Error(body.error ?? "that archive could not be read");
      return body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["archive"] }),
  });

  return (
    <Card>
      <SectionHeading hint="Restored records go back exactly where they were; anything still here is left alone.">
        Put one back
      </SectionHeading>
      {/*
        Labelled, like every other control on the platform. A bare file input
        is announced as "button" and nothing else, so somebody using a screen
        reader meets an unnamed button on a page whose other two buttons write
        to the live tables. Axe rates an unlabelled form control critical.
      */}
      <Field label="Archive file">
        <Input type="file" accept=".zip" ref={file} />
      </Field>
      <Toolbar className="mt-(--gap-stack)">
        <Button
          needs={{ archive: ["create"] }}
          onClick={() => send.mutate("inspect")}
          disabled={send.isPending}
        >
          Check this file
        </Button>
        <ConfirmButton
          variant="secondary"
          confirmLabel="Restore"
          title="Put these records back?"
          message="They go back into the live tables under their original ids. Anything already here is left as it is."
          needs={{ archive: ["create"] }}
          disabled={send.isPending}
          onConfirm={() => send.mutate("restore")}
        >
          Restore it
        </ConfirmButton>
      </Toolbar>
      {send.error ? <ErrorNote error={send.error} /> : null}
      {send.data?.inspected ? (
        <p>
          {send.data.manifest?.set} for{" "}
          {send.data.manifest?.period.from.slice(0, 10)} to{" "}
          {send.data.manifest?.period.to.slice(0, 10)} —{" "}
          {send.data.manifest?.rows.toLocaleString()} records, checksums all
          match.{" "}
          {send.data.mine ? "" : "It was written by a different business."}
        </p>
      ) : null}
      {send.data && send.data.inspected === false ? (
        <p>
          Put back{" "}
          {(send.data.inserted ?? [])
            .reduce((total, i) => total + i.rows, 0)
            .toLocaleString()}{" "}
          records.{" "}
          {send.data.skipped ? `${send.data.skipped} were already here.` : ""}{" "}
          {send.data.summariesRemoved
            ? `${send.data.summariesRemoved} summary entries were taken back out, because the detail they stood for is here again.`
            : ""}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Where archives go.
 *
 * In the module's own settings, with credentials stored here and a Test
 * connection button — never a file on a server somebody may not have shell
 * access to. A folder on this machine is what ships; anything else a module
 * adds appears in this same list and is configured the same way.
 */
function Where() {
  const qc = useQueryClient();
  const stored = useQuery({
    queryKey: ["archive", "destination"],
    queryFn: () => api<Destination>("/api/archive/destination"),
  });
  const destination = stored.data;
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string> | null>(null);
  const [tested, setTested] = useState<{ ok: boolean; detail: string } | null>(
    null,
  );
  const id = chosenId ?? destination?.id ?? "folder";
  const values = edits ?? destination?.values ?? {};
  const setId = setChosenId;
  const setValues = (
    next: (current: Record<string, string>) => Record<string, string>,
  ) => setEdits(next(values));

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; detail: string }>("/api/archive/destination/test", {
        method: "POST",
        body: JSON.stringify({ id, values }),
      }),
    onSuccess: setTested,
  });

  const save = useMutation({
    mutationFn: () =>
      api<Destination>("/api/archive/destination", {
        method: "PUT",
        body: JSON.stringify({ id, values }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["archive", "destination"] }),
  });

  const chosen = destination?.available.find((d) => d.id === id);

  return (
    <Card>
      <SectionHeading hint="By default, this instance's own data directory — download the file, then clear the copy here.">
        Where archives go
      </SectionHeading>
      <Field label="Destination">
        <Select value={id} onChange={(e) => setId(e.target.value)}>
          {destination?.available.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      {chosen ? <p style={muted}>{chosen.description}</p> : null}
      {chosen?.fields.map((field) => (
        <Field key={field.name} label={field.label} hint={field.help}>
          <Input
            type={field.secret ? "password" : "text"}
            value={values[field.name] ?? ""}
            placeholder={field.placeholder ?? destination?.defaultDirectory}
            onChange={(e) =>
              setValues((current) => ({
                ...current,
                [field.name]: e.target.value,
              }))
            }
          />
        </Field>
      ))}
      <Toolbar className="mt-(--gap-stack)">
        <Button
          needs={{ archive: ["connect"] }}
          onClick={() => test.mutate()}
          disabled={test.isPending}
        >
          {test.isPending ? "Testing…" : "Test connection"}
        </Button>
        <Button
          needs={{ archive: ["connect"] }}
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          Save
        </Button>
      </Toolbar>
      {tested ? (
        <p style={tested.ok ? undefined : { color: "var(--text-danger)" }}>
          {tested.detail}
        </p>
      ) : null}
      {/* A test that never reached the destination is not a failed test. */}
      {test.error ? <ErrorNote error={test.error} /> : null}
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

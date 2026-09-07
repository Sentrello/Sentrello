import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, type Meta, api } from "../lib/api";
import { Icon } from "../lib/icons";
import { useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  NeedsPro,
  Row,
  Select,
  Table,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The invoices that raise themselves.
 *
 * A retainer, a subscription, a monthly service charge — the work a business
 * bills without thinking about it, which is exactly the work it forgets to
 * bill. Each row here is a customer, a schedule and the invoice that will be
 * copied, and the last column is the one that matters: when it next runs.
 *
 * The template is a real invoice, not a form. It is priced and corrected on
 * the ordinary invoice screen, so what the customer will receive is a document
 * somebody can open and read first.
 */

interface Profile {
  id: string;
  name: string | null;
  contactId: string;
  interval: string;
  intervalCount: number;
  nextRunAt: string;
  endsOn: string | null;
  autoSend: boolean;
  active: boolean;
  generatedCount: number;
  lastGeneratedAt: string | null;
  templateInvoiceId: string | null;
  templateNumber: string | null;
  templateTotalCents: number | null;
  currency: string | null;
}

const INTERVALS = [
  { id: "daily", one: "day", many: "days" },
  { id: "weekly", one: "week", many: "weeks" },
  { id: "monthly", one: "month", many: "months" },
  { id: "quarterly", one: "quarter", many: "quarters" },
  { id: "yearly", one: "year", many: "years" },
];

/** "Every 2 weeks", not "weekly ×2" — it is read by whoever set it up. */
export function scheduleLabel(interval: string, count: number): string {
  const found = INTERVALS.find((i) => i.id === interval);
  if (!found) return interval;
  return count > 1 ? `Every ${count} ${found.many}` : `Every ${found.one}`;
}

/** Whether the next run has already slipped past — the job has not run. */
export function overdueRun(nextRunAt: string, now = new Date()): boolean {
  return new Date(nextRunAt).getTime() < now.getTime();
}

export function Recurring() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [adding, setAdding] = useState(false);
  // Already in the cache from the shell's own fetch, so this costs no request.
  const tier = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/api/_meta"),
  }).data?.tier;

  const { data, isLoading, error } = useQuery({
    queryKey: ["recurring"],
    queryFn: () => api<{ profiles: Profile[] }>("/api/invoicing/recurring"),
  });

  const contacts = useQuery({
    queryKey: ["contacts", "all"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });
  const customer = (id: string) =>
    contacts.data?.contacts.find((c) => c.id === id)?.name ?? "—";

  const refresh = () => qc.invalidateQueries({ queryKey: ["recurring"] });

  const patch = useMutation({
    mutationFn: (args: { id: string; body: Record<string, unknown> }) =>
      api(`/api/invoicing/recurring/${args.id}`, {
        method: "PATCH",
        body: JSON.stringify(args.body),
      }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/recurring/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  // Before the error, because on Free the error IS the gate answering 404 and
  // "something went wrong" is the wrong thing to tell somebody about a feature
  // they have simply not bought.
  if (tier && tier !== "pro") return <NeedsPro what="Recurring invoicing" />;
  if (error) return <ErrorNote error={error} />;
  if (isLoading) return <Loading />;

  const profiles = data?.profiles ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm" style={muted}>
          Work you bill on a schedule, raised without anybody remembering to.
        </p>
        <div className="ml-auto">
          <Button onClick={() => setAdding((v) => !v)}>
            <span className="flex items-center gap-1.5">
              <Icon name={adding ? "chevron-down" : "plus"} size={15} />
              {adding ? "Close" : "New schedule"}
            </span>
          </Button>
        </div>
      </div>

      {adding ? (
        <NewProfile
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : null}

      {profiles.length === 0 ? (
        <Empty title="Nothing repeats yet">
          Raise the invoice you want repeated, then set a schedule for it. Every
          period it is copied, posted to the books and — if you ask — sent.
        </Empty>
      ) : (
        <Card className="p-0">
          <Table
            headers={[
              "Customer",
              "Repeats",
              "Next",
              "Template",
              { label: "Amount", money: true },
              "Sends itself",
              "Raised",
              "",
            ]}
          >
            {profiles.map((profile) => (
              <Row key={profile.id}>
                <td className="max-w-44 truncate py-2 font-medium">
                  {profile.name ?? customer(profile.contactId)}
                </td>
                <td className="whitespace-nowrap">
                  {scheduleLabel(profile.interval, profile.intervalCount)}
                  {profile.endsOn ? (
                    <span className="ml-1 text-xs" style={muted}>
                      until {formatDate(profile.endsOn)}
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap">
                  {profile.active ? (
                    <span
                      style={
                        overdueRun(profile.nextRunAt)
                          ? { color: "var(--color-warning)" }
                          : undefined
                      }
                      // A next run in the past means the job has not run, which
                      // is a thing to notice rather than a thing to hide.
                      title={
                        overdueRun(profile.nextRunAt)
                          ? "Due — it is raised on the next run"
                          : undefined
                      }
                    >
                      {formatDate(profile.nextRunAt)}
                    </span>
                  ) : (
                    <span style={muted}>Paused</span>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  {profile.templateInvoiceId && profile.templateNumber ? (
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        open({
                          moduleId: "invoicing",
                          recordId: profile.templateInvoiceId ?? "",
                          title: profile.templateNumber ?? "",
                        })
                      }
                    >
                      {profile.templateNumber}
                    </button>
                  ) : (
                    <span style={muted}>Set up by hand</span>
                  )}
                </td>
                <td className="money">
                  {profile.templateTotalCents === null
                    ? "—"
                    : formatMoney(profile.templateTotalCents)}
                </td>
                <td>
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={profile.autoSend}
                      onChange={(e) =>
                        patch.mutate({
                          id: profile.id,
                          body: { autoSend: e.target.checked },
                        })
                      }
                    />
                    {profile.autoSend ? "Yes" : "No"}
                  </label>
                </td>
                <td className="tabular-nums" style={muted}>
                  {profile.generatedCount}
                  {profile.lastGeneratedAt ? (
                    <span className="ml-1 text-xs">
                      last {formatDate(profile.lastGeneratedAt)}
                    </span>
                  ) : null}
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="link-muted mr-3 text-sm"
                    onClick={() =>
                      patch.mutate({
                        id: profile.id,
                        body: { active: !profile.active },
                      })
                    }
                  >
                    {profile.active ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className="text-sm"
                    style={{ color: "var(--color-danger)" }}
                    onClick={() => remove.mutate(profile.id)}
                  >
                    Delete
                  </button>
                </td>
              </Row>
            ))}
          </Table>
        </Card>
      )}

      {patch.error ? <ErrorNote error={patch.error} /> : null}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Setting one up.
 *
 * The template is chosen from the invoices that already exist rather than
 * written here: a schedule that bills a document nobody has seen is how a
 * customer receives a surprise every month.
 */
function NewProfile({ onDone }: { onDone: () => void }) {
  const [templateInvoiceId, setTemplate] = useState("");
  const [interval, setInterval] = useState("monthly");
  const [intervalCount, setCount] = useState(1);
  const [nextRunAt, setNextRun] = useState(today());
  const [endsOn, setEndsOn] = useState("");
  const [autoSend, setAutoSend] = useState(false);

  const invoices = useQuery({
    queryKey: ["invoices", "for-recurring"],
    queryFn: () =>
      api<{
        invoices: {
          id: string;
          number: string;
          totalCents: number;
          contactId: string | null;
        }[];
      }>("/api/invoices?perPage=100"),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/api/invoicing/recurring", {
        method: "POST",
        body: JSON.stringify({
          templateInvoiceId,
          interval,
          intervalCount,
          nextRunAt,
          endsOn: endsOn || null,
          autoSend,
        }),
      }),
    onSuccess: onDone,
  });

  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Invoice to repeat"
          hint="It is copied each period, with a new number and date."
        >
          <Select
            value={templateInvoiceId}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="">Pick an invoice</option>
            {(invoices.data?.invoices ?? []).map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {invoice.number} — {formatMoney(invoice.totalCents)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="How often">
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              className="w-20"
              value={intervalCount}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
            />
            <Select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              {INTERVALS.map((i) => (
                <option key={i.id} value={i.id}>
                  {intervalCount > 1 ? i.many : i.one}
                </option>
              ))}
            </Select>
          </div>
        </Field>

        <Field label="First one" hint="It is raised on or after this date.">
          <Input
            type="date"
            value={nextRunAt}
            onChange={(e) => setNextRun(e.target.value)}
          />
        </Field>

        <Field label="Stop after" hint="Leave empty to run until you stop it.">
          <Input
            type="date"
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
          />
        </Field>

        <Field label="Send it as well">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
            />
            Email it to the customer when it is raised
          </label>
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          onClick={() => create.mutate()}
          disabled={!templateInvoiceId || create.isPending}
        >
          Set it up
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {create.error ? <ErrorNote error={create.error} /> : null}
    </Card>
  );
}

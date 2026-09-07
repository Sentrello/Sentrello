import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, type Meta, api } from "../lib/api";
import { toCents } from "../lib/money";
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
  StatusBadge,
  Table,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The people who pay every month.
 *
 * A subscription business spends its time on four questions: who is on which
 * plan, what are we owed each month, whose trial is about to end, and who has
 * given notice. This screen answers all four on sight, and the rest of it is
 * the handful of things anyone ever does to a subscription — pause, resume,
 * change plan, cancel.
 *
 * The billing itself is the recurring machinery Invoicing already had, which
 * is the point: one scheduler, one set of numbers reaching the ledger.
 */

interface Plan {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
  billingInterval: string | null;
  billingIntervalCount: number;
  active: boolean;
}

interface Subscription {
  id: string;
  name: string | null;
  contactId: string;
  customerName: string | null;
  customerEmail: string | null;
  planItemId: string | null;
  planName: string | null;
  quantity: number;
  unitPriceCents: number | null;
  currency: string;
  interval: string;
  intervalCount: number;
  status: string;
  active: boolean;
  startedAt: string | null;
  trialEndsAt: string | null;
  nextRunAt: string;
  cancelAt: string | null;
  cancelledAt: string | null;
  generatedCount: number;
  lastGeneratedAt: string | null;
  autoSend: boolean;
  externalRef: string | null;
}

const INTERVALS = [
  { id: "weekly", label: "week" },
  { id: "monthly", label: "month" },
  { id: "quarterly", label: "quarter" },
  { id: "yearly", label: "year" },
];

const every = (interval: string, count: number) => {
  const label = INTERVALS.find((i) => i.id === interval)?.label ?? interval;
  return count > 1 ? `every ${count} ${label}s` : `every ${label}`;
};

export function Subscriptions() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"customers" | "plans">("customers");

  const subscriptions = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () =>
      api<{ subscriptions: Subscription[]; monthlyRecurringCents: number }>(
        "/api/invoicing/subscriptions",
      ),
  });
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<{ plans: Plan[] }>("/api/invoicing/plans"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["subscriptions"] });
    qc.invalidateQueries({ queryKey: ["plans"] });
  };

  // Already in the cache from the shell's own fetch, so this costs no request.
  const tier = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/api/_meta"),
  }).data?.tier;

  // Before the error, because on Free the error IS the gate answering 404 and
  // "something went wrong" is the wrong thing to tell somebody about a feature
  // they have simply not bought.
  if (tier && tier !== "pro") return <NeedsPro what="Subscriptions" />;
  if (subscriptions.isLoading) return <Loading />;
  if (subscriptions.error) return <ErrorNote error={subscriptions.error} />;

  const rows = subscriptions.data?.subscriptions ?? [];
  const live = rows.filter((r) => r.active && r.status !== "cancelled");
  const trialing = rows.filter((r) => r.status === "trialing");
  const leaving = rows.filter((r) => r.cancelAt && r.status !== "cancelled");

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Figure label="Subscribers" value={String(live.length)} />
        <Figure
          label="Every month"
          value={formatMoney(subscriptions.data?.monthlyRecurringCents ?? 0)}
        />
        <Figure label="On trial" value={String(trialing.length)} />
        <Figure
          label="Giving notice"
          value={String(leaving.length)}
          warn={leaving.length > 0}
        />
      </div>

      <nav className="flex gap-1 text-sm">
        {(["customers", "plans"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="rounded px-2 py-1"
            style={
              tab === t
                ? {
                    background: "var(--color-brand-500)",
                    color: "var(--color-neutral-50)",
                  }
                : muted
            }
          >
            {t === "customers" ? "Subscribers" : "Plans"}
          </button>
        ))}
      </nav>

      {tab === "customers" ? (
        <Subscribers
          rows={rows}
          plans={plans.data?.plans ?? []}
          onDone={refresh}
        />
      ) : (
        <Plans plans={plans.data?.plans ?? []} onDone={refresh} />
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <Card>
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <p
        className="money mt-1 text-xl font-semibold"
        style={warn ? { color: "var(--color-warning)" } : undefined}
      >
        {value}
      </p>
    </Card>
  );
}

function Subscribers({
  rows,
  plans,
  onDone,
}: {
  rows: Subscription[];
  plans: Plan[];
  onDone: () => void;
}) {
  const [contactId, setContactId] = useState("");
  const [planItemId, setPlanItemId] = useState("");
  const [trialDays, setTrialDays] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });

  const subscribe = useMutation({
    mutationFn: () => {
      const days = Number(trialDays);
      const trialEndsAt =
        Number.isFinite(days) && days > 0
          ? new Date(Date.now() + days * 86_400_000).toISOString()
          : null;
      return api("/api/invoicing/subscriptions", {
        method: "POST",
        // Blank starts today, which is the common case. A subscription that
        // begins on the 1st, agreed on the 20th, is the other one — and the
        // route has always taken it.
        body: JSON.stringify({
          contactId,
          planItemId,
          trialEndsAt,
          startsOn: startsOn || undefined,
        }),
      });
    },
    onSuccess: () => {
      setTrialDays("");
      onDone();
    },
  });

  const act = useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) =>
      api(`/api/invoicing/subscriptions/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(input.body),
      }),
    onSuccess: onDone,
  });

  const sellable = plans.filter((plan) => plan.active);

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem_9rem_auto]">
          <Field label="Customer">
            <Select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">Choose</option>
              {(contacts.data?.contacts ?? []).map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Plan">
            <Select
              value={planItemId}
              onChange={(e) => setPlanItemId(e.target.value)}
            >
              <option value="">Choose</option>
              {sellable.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} — {formatMoney(plan.unitPriceCents)}{" "}
                  {every(
                    plan.billingInterval ?? "monthly",
                    plan.billingIntervalCount,
                  )}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Free days first">
            <Input
              type="number"
              min="0"
              placeholder="0"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
            />
          </Field>
          <Field label="Starts" hint="Blank is today.">
            <Input
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => subscribe.mutate()}
              disabled={subscribe.isPending || !contactId || !planItemId}
            >
              Subscribe
            </Button>
          </div>
        </div>
        {sellable.length === 0 ? (
          <p className="mt-2 text-xs" style={muted}>
            No plans yet — make one on the Plans tab, and it becomes something
            you can put people on.
          </p>
        ) : null}
        {subscribe.error ? <ErrorNote error={subscribe.error} /> : null}
      </Card>

      {rows.length === 0 ? (
        <Empty title="Nobody is subscribed yet">
          A subscription bills its plan on a schedule and raises a real invoice
          each period, in the same books as everything else.
        </Empty>
      ) : (
        <Table
          headers={[
            "Customer",
            "Plan",
            "How often",
            { label: "Each time", money: true },
            "Status",
            "Next invoice",
            "",
          ]}
        >
          {rows.map((row) => (
            <Row key={row.id}>
              <td className="py-2 font-medium">
                <button
                  type="button"
                  className="underline"
                  onClick={() => setOpen(open === row.id ? null : row.id)}
                >
                  {row.customerName ?? "—"}
                </button>
              </td>
              <td>{row.planName ?? row.name ?? "—"}</td>
              <td style={muted}>{every(row.interval, row.intervalCount)}</td>
              <td className="money">
                {formatMoney(
                  (row.unitPriceCents ?? 0) * row.quantity,
                  row.currency,
                )}
              </td>
              <td>
                <StatusBadge
                  status={
                    row.cancelAt && row.status !== "cancelled"
                      ? "ending"
                      : row.status
                  }
                />
              </td>
              <td>
                {row.status === "cancelled"
                  ? "—"
                  : row.status === "paused"
                    ? "paused"
                    : formatDate(row.nextRunAt)}
              </td>
              <td className="space-x-2 text-xs">
                {row.status === "paused" ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() =>
                      act.mutate({ id: row.id, body: { action: "resume" } })
                    }
                  >
                    Resume
                  </button>
                ) : null}
                {row.status === "active" || row.status === "trialing" ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() =>
                      act.mutate({ id: row.id, body: { action: "pause" } })
                    }
                  >
                    Pause
                  </button>
                ) : null}
                {row.cancelAt && row.status !== "cancelled" ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() =>
                      act.mutate({ id: row.id, body: { action: "uncancel" } })
                    }
                  >
                    Keep them
                  </button>
                ) : null}
                {row.status !== "cancelled" && !row.cancelAt ? (
                  <>
                    <button
                      type="button"
                      className="underline"
                      style={muted}
                      onClick={() =>
                        act.mutate({ id: row.id, body: { action: "cancel" } })
                      }
                    >
                      Cancel
                    </button>
                    {/*
                      Stopping now, rather than at the end of the period they
                      have already paid for.

                      The route has always taken it and nothing could ask for
                      it, so a disputed or fraudulent subscription kept billing
                      until its period ran out. It refunds nothing either way —
                      the difference is only whether one more invoice is raised.
                    */}
                    <button
                      type="button"
                      className="underline"
                      style={muted}
                      onClick={() =>
                        act.mutate({
                          id: row.id,
                          body: { action: "cancel", immediately: true },
                        })
                      }
                    >
                      Stop now
                    </button>
                  </>
                ) : null}
              </td>
            </Row>
          ))}
        </Table>
      )}
      {act.error ? <ErrorNote error={act.error} /> : null}

      {open ? (
        <Detail
          subscription={rows.find((r) => r.id === open) as Subscription}
          plans={sellable}
          onDone={onDone}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/** One subscriber: what they pay, what they have been billed, what to change. */
function Detail({
  subscription,
  plans,
  onDone,
  onClose,
}: {
  subscription: Subscription;
  plans: Plan[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [price, setPrice] = useState(
    subscription.unitPriceCents === null
      ? ""
      : (subscription.unitPriceCents / 100).toFixed(2),
  );

  const invoices = useQuery({
    queryKey: ["subscription-invoices", subscription.id],
    queryFn: () =>
      api<{
        invoices: {
          id: string;
          number: string;
          status: string;
          issueDate: string;
          totalCents: number;
          currency: string;
        }[];
      }>(`/api/invoicing/subscriptions/${subscription.id}/invoices`),
  });

  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/invoicing/subscriptions/${subscription.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: onDone,
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium">
          {subscription.customerName ?? "Subscriber"}
          {subscription.customerEmail ? (
            <span className="ml-2 text-xs" style={muted}>
              {subscription.customerEmail}
            </span>
          ) : null}
        </p>
        <button
          type="button"
          className="text-xs underline"
          style={muted}
          onClick={onClose}
        >
          close
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_9rem_auto]">
        <Field label="Move to plan">
          <Select
            value={subscription.planItemId ?? ""}
            onChange={(e) => change.mutate({ planItemId: e.target.value })}
          >
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Their price">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <div className="flex items-end">
          <Button
            onClick={() => change.mutate({ unitPriceCents: toCents(price) })}
            disabled={change.isPending}
          >
            Save price
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs" style={muted}>
        A change takes effect on the next invoice. The period they are in is
        already paid for, and charging the difference today is the kind of
        surprise that ends a subscription.
        {subscription.cancelAt
          ? ` Billing stops on ${formatDate(subscription.cancelAt)}.`
          : ""}
        {subscription.trialEndsAt
          ? ` Free until ${formatDate(subscription.trialEndsAt)}.`
          : ""}
      </p>
      {change.error ? <ErrorNote error={change.error} /> : null}

      <div className="mt-4">
        <p className="mb-2 text-sm font-medium">
          Billed so far — {subscription.generatedCount} invoice
          {subscription.generatedCount === 1 ? "" : "s"}
        </p>
        {invoices.isLoading ? <Loading /> : null}
        {invoices.data && invoices.data.invoices.length > 0 ? (
          <Table
            headers={[
              "Date",
              "Invoice",
              "Status",
              { label: "Amount", money: true },
            ]}
          >
            {invoices.data.invoices.map((invoice) => (
              <Row key={invoice.id}>
                <td className="py-2">{formatDate(invoice.issueDate)}</td>
                <td style={muted}>{invoice.number}</td>
                <td>
                  <StatusBadge status={invoice.status} />
                </td>
                <td className="money">
                  {formatMoney(invoice.totalCents, invoice.currency)}
                </td>
              </Row>
            ))}
          </Table>
        ) : null}
      </div>
    </Card>
  );
}

function Plans({ plans, onDone }: { plans: Plan[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [interval, setInterval] = useState("monthly");

  const create = useMutation({
    mutationFn: () =>
      api("/api/invoicing/plans", {
        method: "POST",
        body: JSON.stringify({
          name,
          unitPriceCents: toCents(price),
          billingInterval: interval,
        }),
      }),
    onSuccess: () => {
      setName("");
      setPrice("");
      onDone();
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/plans/${id}`, { method: "DELETE" }),
    onSuccess: onDone,
  });

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem_10rem_auto]">
          <Field label="Plan">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Support, monthly"
            />
          </Field>
          <Field label="Price">
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
          <Field label="Billed">
            <Select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              {INTERVALS.map((i) => (
                <option key={i.id} value={i.id}>
                  every {i.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => create.mutate()}
              disabled={create.isPending || !name || !price}
            >
              Add plan
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          A plan is something you sell with a period attached — priced and taxed
          exactly like any other line on an invoice, because that is what it
          becomes each time it bills.
        </p>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Card>

      {plans.length === 0 ? (
        <Empty title="No plans yet" />
      ) : (
        <Table
          headers={["Plan", { label: "Price", money: true }, "Billed", ""]}
        >
          {plans.map((plan) => (
            <Row key={plan.id}>
              <td
                className="py-2 font-medium"
                style={plan.active ? undefined : muted}
              >
                {plan.name}
                {plan.active ? "" : " (withdrawn)"}
              </td>
              <td className="money">{formatMoney(plan.unitPriceCents)}</td>
              <td style={muted}>
                {every(
                  plan.billingInterval ?? "monthly",
                  plan.billingIntervalCount,
                )}
              </td>
              <td>
                {plan.active ? (
                  <button
                    type="button"
                    className="text-xs underline"
                    style={muted}
                    onClick={() => withdraw.mutate(plan.id)}
                  >
                    Withdraw
                  </button>
                ) : null}
              </td>
            </Row>
          ))}
        </Table>
      )}
      <p className="text-xs" style={muted}>
        Withdrawing a plan stops it being sold. Everybody already on it keeps
        their price and their dates.
      </p>
      {withdraw.error ? <ErrorNote error={withdraw.error} /> : null}
    </div>
  );
}

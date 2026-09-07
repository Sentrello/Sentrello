import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Avatar } from "../lib/avatar";
import { PairedBars } from "../lib/charts";
import { Icon } from "../lib/icons";
import { useNavigation } from "../lib/navigation";
import { TaskDialog, TaskRow } from "../lib/tasks";
import { Card, ErrorNote, Loading, formatMoney, muted } from "../lib/ui";

/**
 * The CRM's own front page.
 *
 * Four panels, in the order somebody needs them on a Tuesday morning: what is
 * due, what is about to land, who is live, what happened lately. The reference's
 * dashboard is the model — short, and every row a link to the record it is
 * about rather than a number to admire.
 *
 * Its "Welcome" stepper is deliberately not here. A panel explaining the
 * product to somebody who already bought it is a panel they scroll past
 * forever, and it takes the space the actual work should occupy.
 */

interface CrmDashboard {
  hotContacts: {
    id: string;
    name: string;
    email: string | null;
    companyId: string | null;
    lastActivityAt: string;
  }[];
  dealOutcomes: {
    month: string;
    wonCount: number;
    wonCents: number;
    lostCount: number;
    lostCents: number;
  }[];
  upcoming: {
    horizonDays: number;
    totalCents: number;
    overdue: { count: number; totalCents: number };
  };
  latestActivity: {
    id: string;
    type: string;
    body: string | null;
    occurredAt: string;
    contactId: string | null;
  }[];
  tasks: {
    id: string;
    title: string;
    type: string | null;
    dueAt: string;
    contactId: string | null;
    overdue: boolean;
  }[];
  goingCold: number;
}

/** "2026-08" is a key, not a label. An axis wants "Aug". */
function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString(undefined, {
    month: "short",
    timeZone: "UTC",
  });
}

/** "3 days ago", because an exact timestamp is not what anybody is asking. */
function ago(value: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  const days = Math.floor(seconds / 86_400);
  if (days >= 14) return `${Math.floor(days / 7)} weeks ago`;
  if (days >= 1) return days === 1 ? "yesterday" : `${days} days ago`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  // Minutes matter here. Without this tier everything touched in the last hour
  // read "just now", which on a screen full of them says nothing at all — and
  // is plainly wrong about something forty minutes old.
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 1)
    return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  return "just now";
}

/**
 * What is due, and the buttons that clear it.
 *
 * Its own component because the dialog needs somewhere to keep its open state,
 * and the dashboard is a plain render otherwise. The contact list comes with
 * it so the dialog can offer a subject: the reference asks who a task is about,
 * and a dashboard has no record to assume the answer from.
 */
function TasksPanel({ tasks }: { tasks: CrmDashboard["tasks"] }) {
  const [adding, setAdding] = useState(false);
  const contacts = useQuery({
    queryKey: ["contacts", "for-tasks"],
    queryFn: () =>
      api<{ contacts: { id: string; name: string }[] }>(
        "/api/contacts?perPage=200&sort=name&order=asc",
      ),
    // Only fetched when somebody opens the dialog. A dashboard that pulls the
    // whole contact list on every load pays for a form most visits never open.
    enabled: adding,
  });

  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between">
        <p className="font-medium">Your tasks</p>
        <button
          type="button"
          className="link-muted"
          aria-label="Add a task"
          title="Add a task"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      {tasks.length ? (
        <ul>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              invalidate={[["crm-dashboard"], ["tasks"]]}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm" style={muted}>
          Nothing due. Tasks you add to a contact, company or deal appear here.
        </p>
      )}
      <TaskDialog
        open={adding}
        onClose={() => setAdding(false)}
        invalidate={[["crm-dashboard"], ["tasks"]]}
        subjects={contacts.data?.contacts ?? []}
      />
    </Card>
  );
}

export function CrmDashboard() {
  const { open, go } = useNavigation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["crm-dashboard"],
    queryFn: () => api<CrmDashboard>("/api/crm/dashboard"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const wonTotal = data.dealOutcomes.reduce((sum, m) => sum + m.wonCents, 0);
  const lostTotal = data.dealOutcomes.reduce((sum, m) => sum + m.lostCents, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/*
        Tasks first. Everything else on this screen is something to know;
        this is the only panel that is something to do.
      */}
      <TasksPanel tasks={data.tasks} />

      {/*
        Won against lost, over six months.

        This replaced "closing in 30 days", which was a forecast — a number
        nobody can check, and one that says nothing about whether the business
        is actually winning work. Won and lost are facts, and six months of
        them is the question a sales screen exists to answer.
      */}
      <Card>
        <div className="mb-3 flex items-baseline justify-between">
          <p className="font-medium">Deals</p>
          <button
            type="button"
            className="text-sm link-muted"
            onClick={() => go("deals", "Deals")}
          >
            Open the board
          </button>
        </div>

        <PairedBars
          upLabel={`Won · ${formatMoney(wonTotal)}`}
          downLabel={`Lost · ${formatMoney(lostTotal)}`}
          points={data.dealOutcomes.map((month) => ({
            label: monthLabel(month.month),
            up: month.wonCents,
            down: month.lostCents,
            display: `${month.wonCount} won ${formatMoney(month.wonCents)}, ${month.lostCount} lost ${formatMoney(month.lostCents)}`,
          }))}
        />

        {data.upcoming.overdue.count > 0 ? (
          /*
            A deal past its close date is a conversation somebody is avoiding,
            and it is the one thing on this panel worth acting on today.
          */
          <button
            type="button"
            className="mt-3 w-full rounded border px-3 py-2 text-left text-sm"
            style={{
              borderColor: "var(--color-warning)",
              color: "var(--color-warning)",
            }}
            onClick={() => go("deals", "Deals")}
          >
            {data.upcoming.overdue.count} deal
            {data.upcoming.overdue.count === 1 ? "" : "s"} past the date they
            were meant to close —{" "}
            {formatMoney(data.upcoming.overdue.totalCents)}
          </button>
        ) : null}
      </Card>

      {/*
        Who is live. Ranked by what has actually happened rather than
        alphabetically — contacts nobody has ever spoken to are absent, because
        a list that opens with strangers is one people learn to ignore.
      */}
      <Card>
        <div className="mb-3 flex items-baseline justify-between">
          <p className="font-medium">Hot contacts</p>
          <span className="flex items-center gap-3">
            {data.goingCold > 0 ? (
              <button
                type="button"
                className="text-xs link-muted"
                onClick={() => go("contacts", "Contacts")}
              >
                {data.goingCold} going quiet
              </button>
            ) : null}
            {/*
              The contact form, not a dialog — which is what the reference
              does too, and for the same reason: a contact is pronouns, several
              labelled emails and phones, a company, an owner and a background
              note, and none of that belongs in a box somebody has to scroll.
            */}
            <button
              type="button"
              className="link-muted"
              aria-label="Add a contact"
              title="Add a contact"
              onClick={() => go("contacts", "Contacts", "new")}
            >
              <Icon name="plus" size={16} />
            </button>
          </span>
        </div>

        {data.hotContacts.length ? (
          <ul className="space-y-1">
            {data.hotContacts.map((contact) => (
              <li key={contact.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 border-t py-2 text-left text-sm first:border-0"
                  style={{ borderColor: "var(--border)" }}
                  onClick={() =>
                    open({
                      moduleId: "contacts",
                      recordId: contact.id,
                      title: contact.name,
                    })
                  }
                >
                  <Avatar
                    src={`/api/crm/contacts/${contact.id}/image`}
                    name={contact.name}
                    size={32}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{contact.name}</span>
                    <span className="block truncate text-xs" style={muted}>
                      {contact.email ?? "no email"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs" style={muted}>
                    {ago(contact.lastActivityAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={muted}>
            Nothing logged yet. Calls, emails and notes on a contact show up
            here.
          </p>
        )}
      </Card>

      <Card>
        <p className="mb-3 font-medium">Latest activity</p>
        {data.latestActivity.length ? (
          <ul className="space-y-1">
            {data.latestActivity.map((activity) => (
              <li
                key={activity.id}
                className="border-t py-1.5 text-sm first:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className="text-xs uppercase tracking-wide"
                    style={muted}
                  >
                    {activity.type}
                  </span>
                  <span className="shrink-0 text-xs" style={muted}>
                    {ago(activity.occurredAt)}
                  </span>
                </div>
                {activity.body ? (
                  <p className="mt-0.5 line-clamp-2">{activity.body}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={muted}>
            No calls, emails or notes recorded yet.
          </p>
        )}
      </Card>
    </div>
  );
}

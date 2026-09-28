/**
 * A task, wherever it is shown.
 *
 * One row and one dialog, used by the CRM dashboard, the contact page and the
 * company page. Written once because the four actions have to behave the same
 * in all three: a task ticked off on a company page and the same task ticked
 * off on the dashboard cannot mean two different things, and three copies of
 * this is how they come to.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api, may } from "./api";
import { Icon } from "./icons";
import {
  Button,
  Dialog,
  Field,
  Input,
  MenuItem,
  REFUSED,
  RowMenu,
  Select,
  Warning,
  muted,
} from "./ui";

export interface Task {
  id: string;
  title: string;
  type: string | null;
  description?: string | null;
  dueAt: string | null;
  done?: boolean;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
}

/** What the reference offers, and what a CRM task actually is. */
const TASK_TYPES = ["call", "email", "meeting", "demo", "follow-up", "other"];

/**
 * How many whole days away a due date is, counted on the calendar.
 *
 * Not by subtracting timestamps. A due date is a day somebody picked, stored
 * at midday, and by three in the afternoon that midday is in the past — so a
 * task due *today* compared as an instant is already late. Nobody thinks their
 * two o'clock is overdue at one.
 *
 * Negative is late, 0 is today, positive is still to come.
 */
function daysUntil(value: string): number {
  const due = new Date(value);
  const today = new Date();
  const atMidnight = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((atMidnight(due) - atMidnight(today)) / 86_400_000);
}

/** Whether a task is actually late — a full day past, not an hour past. */
export function isOverdue(value: string | null): boolean {
  return value ? daysUntil(value) < 0 : false;
}

/**
 * "in 4 days", or how late it is — which is the half that matters.
 *
 * Kept here beside the row that renders it rather than in the dashboard, now
 * that three screens draw the same row.
 */
export function untilDue(value: string | null): string {
  if (!value) return "no date";
  const days = daysUntil(value);
  if (days === 0) return "today";
  if (days < 0) return days === -1 ? "yesterday" : `${-days} days late`;
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

/**
 * Everything that writes to a task, and what to refresh afterwards.
 *
 * The caller says which queries its screen is built from, because the same row
 * appears on a dashboard keyed one way and a contact page keyed another, and a
 * row that updates the server without updating the screen it is on looks
 * exactly like a row that did nothing.
 */
function useTaskActions(invalidate: unknown[][]) {
  const client = useQueryClient();
  const settle = () => {
    for (const key of invalidate) client.invalidateQueries({ queryKey: key });
  };

  return {
    complete: useMutation({
      mutationFn: ({ id, done }: { id: string; done: boolean }) =>
        api(`/api/tasks/${id}/complete`, {
          method: "POST",
          body: JSON.stringify({ done }),
        }),
      onSuccess: settle,
    }),
    postpone: useMutation({
      mutationFn: ({ id, by }: { id: string; by: "day" | "week" }) =>
        api(`/api/tasks/${id}/postpone`, {
          method: "POST",
          body: JSON.stringify({ by }),
        }),
      onSuccess: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/api/tasks/${id}`, { method: "DELETE" }),
      onSuccess: settle,
    }),
    save: useMutation({
      mutationFn: ({
        id,
        ...body
      }: { id?: string } & Record<string, unknown>) =>
        api(id ? `/api/tasks/${id}` : "/api/tasks", {
          method: id ? "PATCH" : "POST",
          body: JSON.stringify(body),
        }),
      onSuccess: settle,
    }),
  };
}

/**
 * The overflow menu.
 *
 * Four buttons and a boolean rather than a popover library, because that is all
 * it is. The items are the reference's four, in its order.
 */
function TaskMenu({
  onPostpone,
  onEdit,
  onDelete,
}: {
  onPostpone: (by: "day" | "week") => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <RowMenu label="this task">
      {(close) => (
        <>
          {[
            ["Postpone to tomorrow", () => onPostpone("day"), false],
            ["Postpone to next week", () => onPostpone("week"), false],
            ["Edit", onEdit, false],
            ["Delete", onDelete, true],
          ].map(([label, onClick, danger]) => (
            /*
             * Every item here writes the task — postponing it, editing it,
             * deleting it — so every one takes the permission. Built in a
             * loop, which is why the scanner that reads handlers never saw
             * them: there is one handler for four controls and it calls a
             * prop rather than a mutation. A read-only role was offered all
             * four.
             */
            <MenuItem
              key={label as string}
              needs={{ crm: ["update"] }}
              style={danger ? { color: "var(--text-danger)" } : undefined}
              onClick={() => {
                close();
                (onClick as () => void)();
              }}
            >
              {label as string}
            </MenuItem>
          ))}
        </>
      )}
    </RowMenu>
  );
}

/**
 * One task: tick it off, or open the menu.
 *
 * The checkbox is the whole of "done" — a task list where finishing something
 * needs a form is a task list nobody keeps up to date.
 */
export function TaskRow({
  task,
  invalidate,
  subtitle,
  taskTypes,
}: {
  task: Task;
  invalidate: unknown[][];
  /** What it is about, when the screen is not already about that thing. */
  subtitle?: ReactNode;
  taskTypes?: string[];
}) {
  const { complete, postpone, remove } = useTaskActions(invalidate);
  const [editing, setEditing] = useState(false);
  const overdue = isOverdue(task.dueAt);

  return (
    <li className="flex items-start gap-2 border-t py-1.5 text-sm first:border-0 border-line">
      {/* Ticking a task writes it. A checkbox has no primitive to hang
          `needs` on, so it asks directly — the same way the compliance
          screen's do. */}
      <input
        type="checkbox"
        checked={task.done ?? false}
        aria-label={`Mark "${task.title}" done`}
        className="mt-1 shrink-0"
        disabled={!may("crm", "update")}
        title={may("crm", "update") ? undefined : REFUSED}
        onChange={(e) =>
          complete.mutate({ id: task.id, done: e.target.checked })
        }
      />
      <span className="min-w-0 flex-1">
        <span className={task.done ? "line-through opacity-60" : ""}>
          {task.type ? <strong className="mr-1">{task.type}</strong> : null}
          {task.title}
        </span>
        {task.description ? (
          <span className="block text-xs" style={muted}>
            {task.description}
          </span>
        ) : null}
        <span className="block text-xs" style={muted}>
          <span
            style={
              overdue && !task.done
                ? { color: "var(--text-warning)" }
                : undefined
            }
          >
            {untilDue(task.dueAt)}
          </span>
          {subtitle ? <> · {subtitle}</> : null}
        </span>
      </span>
      <TaskMenu
        onPostpone={(by) => postpone.mutate({ id: task.id, by })}
        onEdit={() => setEditing(true)}
        onDelete={() => remove.mutate(task.id)}
      />
      <TaskDialog
        open={editing}
        task={task}
        invalidate={invalidate}
        taskTypes={taskTypes}
        onClose={() => setEditing(false)}
      />
    </li>
  );
}

/**
 * Adding a task, or editing one.
 *
 * The reference's four fields — what it is, who it is about, when it is due,
 * what kind — plus the detail line, which is the difference between "call
 * Dave" and "he wants the revised figure for the second unit before he signs".
 * Nothing beyond that: a task somebody has to fill in eight boxes for is a task
 * they write on paper instead.
 *
 * The subject arrives fixed from a contact or company page, where the answer is
 * already known and asking again would be a question with one possible answer.
 */
export function TaskDialog({
  open,
  onClose,
  task,
  invalidate,
  subject,
  subjects,
  taskTypes,
}: {
  open: boolean;
  onClose: () => void;
  task?: Task;
  invalidate: unknown[][];
  /** Fixed by the screen: a contact or company page knows what this is about. */
  subject?: { contactId?: string; companyId?: string; dealId?: string };
  /** Or offered as a choice, which is what the dashboard needs. */
  subjects?: { id: string; name: string }[];
  /** This business's own list, from CRM settings, when the screen has it. */
  taskTypes?: string[];
}) {
  const { save } = useTaskActions(invalidate);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [contactId, setContactId] = useState(task?.contactId ?? "");
  const [type, setType] = useState(task?.type ?? "");
  const [dueAt, setDueAt] = useState(
    task?.dueAt
      ? task.dueAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10),
  );
  const types = taskTypes?.length ? taskTypes : TASK_TYPES;

  const submit = () => {
    if (!title.trim()) return;
    save.mutate(
      {
        ...(task ? { id: task.id } : {}),
        title: title.trim(),
        description: description.trim() || null,
        type: type || null,
        // Midday, for the same reason a backdated invoice is stamped at
        // midday: a bare date read as midnight puts somebody west of UTC on
        // the day before the one they picked.
        dueAt: dueAt ? `${dueAt}T12:00:00.000Z` : null,
        ...(subject ?? (contactId ? { contactId } : {})),
      },
      {
        onSuccess: () => {
          if (!task) {
            setTitle("");
            setDescription("");
          }
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      title={task ? "Edit task" : "Create task"}
      open={open}
      onClose={onClose}
    >
      <div className="flex flex-col gap-(--gap-toolbar)">
        <Field label="Description">
          <Input
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Call about the lease renewal"
          />
        </Field>

        <Field
          label="Notes"
          hint="What it actually involves, beyond the one line."
        >
          <textarea
            value={description}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{
              background: "var(--surface-raised)",
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
          />
        </Field>

        {subjects ? (
          <Field label="Contact">
            <Select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">Nobody in particular</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date">
            <Input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">None</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {save.isError ? (
          <Warning>
            That did not save. Check the description and try again.
          </Warning>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!title.trim() || save.isPending}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A panel of tasks with its own add button.
 *
 * What the contact page and the company page both need, so neither writes it.
 */
export function TaskList({
  tasks,
  invalidate,
  subject,
  taskTypes,
  emptyText = "Nothing outstanding.",
}: {
  tasks: Task[];
  invalidate: unknown[][];
  subject: { contactId?: string; companyId?: string; dealId?: string };
  taskTypes?: string[];
  emptyText?: string;
}) {
  const [adding, setAdding] = useState(false);
  // Outstanding first: the point of a task list is what has not happened.
  const ordered = [...tasks].sort(
    (a, b) => Number(a.done ?? false) - Number(b.done ?? false),
  );

  return (
    <>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="font-medium">Tasks</p>
        <button
          type="button"
          className="link-muted"
          aria-label="Add a task"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      {ordered.length ? (
        <ul>
          {ordered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              invalidate={invalidate}
              taskTypes={taskTypes}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm" style={muted}>
          {emptyText}
        </p>
      )}
      <TaskDialog
        open={adding}
        onClose={() => setAdding(false)}
        invalidate={invalidate}
        subject={subject}
        taskTypes={taskTypes}
      />
    </>
  );
}

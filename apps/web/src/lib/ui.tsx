/**
 * The small set of primitives every screen is built from.
 *
 * Hand-written rather than pulled from a component library: the whole product
 * is tables, forms and money, and each of these is a few lines. Every one reads
 * the design tokens in index.css, so light and dark come free and the app can
 * be rethemed from one file.
 */
import { type ReactNode, useEffect, useRef } from "react";

export const border = { borderColor: "var(--border)" };
export const muted = { color: "var(--text-muted)" };
const raised = { background: "var(--surface-raised)", ...border };

/**
 * How this person wants dates and money written.
 *
 * A module-level value set once when the profile loads, rather than a context
 * threaded through every screen: `formatMoney` and `formatDate` are called
 * from dozens of places, most of them deep inside tables, and passing a
 * preference to each one would touch every file to change a comma.
 */
let formats = { currency: "USD", dateFormat: "MDY", timezone: "" };

export function setFormats(next: Partial<typeof formats>) {
  formats = { ...formats, ...next };
}

/** Cents to "$1,234.56". Money never arrives as a float and never becomes one. */
export function formatMoney(
  cents: number,
  currency = formats.currency,
): string {
  /**
   * A figure that is not a number is never printed as one.
   *
   * `formatMoney(undefined)` used to render "$NaN", and did — on the
   * accounting Reports screen, because the component read `cents` from a
   * response whose field is `balanceCents`. The route was right and the
   * arithmetic was right; only the property name was wrong, and no test can
   * see that. It reached a screen a business makes decisions on.
   *
   * A dash, and a complaint in the console. Never a plausible-looking
   * number: showing "$0.00" for a figure nobody computed would be the worse
   * failure, because it reads as an answer.
   */
  if (!Number.isFinite(cents)) {
    console.error("[ui] formatMoney was given", cents);
    return "—";
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
}

/** Basis points to "8.75%". */
export function formatRate(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/**
 * Whether this value is a calendar date rather than a moment in time.
 *
 * A due date, an expiry, a date of birth: somebody typed 10 September and
 * meant 10 September everywhere. Those are stored as midnight UTC, and
 * formatting midnight UTC in a timezone west of it shows the day before — an
 * insurance certificate said to expire a day early, an invoice said to be due
 * a day early, for every customer in our first market.
 *
 * A real timestamp landing on exactly midnight UTC is a one-in-86-million
 * coincidence, and shows the same day it already showed to anyone at or east
 * of UTC. The trade is worth it.
 */
function isCalendarDate(value: string | Date): boolean {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return true;
  }
  const d = typeof value === "string" ? new Date(value) : value;
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  // The order somebody reads a date in is not a matter of taste — 03/04 is two
  // different days depending on where you live, and an invoice date being
  // misread by a month is a real argument with a customer.
  const locale =
    formats.dateFormat === "ISO"
      ? "en-CA"
      : formats.dateFormat === "DMY"
        ? "en-GB"
        : "en-US";
  const timeZone = isCalendarDate(value)
    ? "UTC"
    : formats.timezone || undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

export function Button({
  children,
  variant = "primary",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  const styles = {
    primary: {
      background: "var(--color-brand-500)",
      color: "var(--color-neutral-50)",
    },
    secondary: { background: "transparent", ...border, color: "var(--text)" },
    danger: { background: "var(--color-danger)", color: "white" },
  }[variant];

  return (
    <button
      type="button"
      {...rest}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
        variant === "secondary" ? "border" : ""
      } ${rest.className ?? ""}`}
      style={{ ...styles, ...rest.style }}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    // The control is always the child, so the association is implicit and
    // valid HTML. The rule cannot see through the component boundary to
    // confirm that, which is why it is disabled here and nowhere else.
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is passed as children
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs" style={muted}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/**
 * A default the caller can actually override.
 *
 * `w-full` was baked in ahead of the caller's classes, and which one wins is
 * decided by the order Tailwind emits its rules — not by the order they
 * appear in the string. So `className="w-auto"` on a Select silently lost,
 * and a category filter meant to be as wide as its longest option stretched
 * across the whole toolbar. If the caller named a width, this stands aside.
 */
function withWidth(className: string | undefined): string {
  return /(^|\s)(w-|min-w-|max-w-)/.test(className ?? "") ? "" : "w-full";
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`${withWidth(props.className)} rounded border px-2 py-1.5 text-sm ${props.className ?? ""}`}
      style={{ ...raised, ...props.style }}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`${withWidth(props.className)} rounded border px-2 py-1.5 text-sm ${props.className ?? ""}`}
      style={{ ...raised, ...props.style }}
    />
  );
}

/**
 * A modal, on top of the browser's own.
 *
 * `<dialog showModal()>` rather than a div with a high z-index, because the
 * browser already does the parts that are easy to get wrong and tedious to
 * test: the focus trap, returning focus to whatever opened it, Escape, the
 * inert backdrop, and keeping the whole thing out of the accessibility tree
 * while it is closed. A hand-rolled overlay is fifty lines to reimplement
 * badly.
 *
 * Escape and a backdrop click both close it. That is the browser's `cancel`
 * event for the first and an explicit check for the second — a click landing
 * on the dialog element itself rather than on its contents happened on the
 * backdrop, since the contents fill the box.
 */
/**
 * How wide a dialog gets.
 *
 * A confirmation and an HTML editor are both dialogs and are not the same
 * shape. Named sizes rather than a free className, so every dialog in the
 * product is one of three widths.
 */
const dialogWidths = {
  md: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
} as const;

export function Dialog({
  title,
  open,
  onClose,
  size = "md",
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  size?: keyof typeof dialogWidths;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // showModal() on an already-open dialog throws, and close() on a closed
    // one is a no-op that still fires nothing — so both are guarded.
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    // The keyboard route out is Escape, which the browser fires as `cancel` and
    // is handled directly below. The rule wants a key handler beside every
    // click handler and cannot see that this one already has the better
    // version of it — a backdrop is not reachable by keyboard in the first
    // place, because the modal traps focus inside itself.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by onCancel
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      /*
        `m-auto` is doing real work. A native dialog centres itself with
        `margin: auto`, and the CSS reset sets `margin: 0` on everything —
        so without this it opens pinned to the top-left corner of the screen.
      */
      className={`m-auto w-full ${dialogWidths[size] ?? dialogWidths.md} rounded border p-0 backdrop:bg-black/50`}
      /*
        `color` is not decoration here. The browser's own stylesheet gives a
        dialog `color: CanvasText`, which resolves to black whatever the page's
        theme variables say — so in dark mode the whole dialog rendered black
        text on a dark panel. Every other surface inherits from the body and
        never hits this.
      */
      style={{ ...raised, color: "var(--text)" }}
      aria-label={title}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={border}
      >
        <p className="font-medium">{title}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="link-muted text-lg leading-none"
        >
          ×
        </button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  // Same rule as the inputs above: a caller that names its own padding gets
  // it, rather than losing to whichever rule Tailwind happened to emit last.
  const padding = /(^|\s)p-/.test(className) ? "" : "p-4";
  return (
    <div className={`rounded border ${padding} ${className}`} style={raised}>
      {children}
    </div>
  );
}

export function Table({
  headers,
  children,
}: {
  headers: (string | { label: string; money?: boolean })[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="app-table w-full text-sm">
        <thead>
          <tr className="border-b text-left" style={border}>
            {headers.map((h) => {
              const label = typeof h === "string" ? h : h.label;
              const money = typeof h !== "string" && h.money;
              return (
                <th
                  key={label}
                  className={`py-2 font-medium ${money ? "money" : ""}`}
                >
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b" style={border}>
      {children}
    </tr>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded border p-8 text-center" style={border}>
      <p className="font-medium">{title}</p>
      {children ? (
        <p className="mt-1 text-sm" style={muted}>
          {children}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a Pro screen says on a Free instance.
 *
 * Reachable by a bookmark or a typed address even though the sidebar does not
 * offer it — and after a licence lapses, by a link that worked yesterday. The
 * routes behind these screens answer 404, so without this the answer to "where
 * did Recurring go" is a red error box, which reads as something broken rather
 * than something not bought.
 *
 * It says the data is still there because that is the promise the Pro page
 * makes, and it is the first thing somebody whose licence has just lapsed
 * wants to know.
 */
export function NeedsPro({ what }: { what: string }) {
  return (
    <Empty title={`${what} is part of Pro`}>
      Nothing has been lost — whatever you set up is still here and starts
      working again as soon as a licence is in place. Add one under Settings →
      Licence.
    </Empty>
  );
}

export function Loading() {
  return (
    <p className="text-sm" style={muted}>
      Loading…
    </p>
  );
}

/**
 * One place where a failed request becomes something a person can act on.
 *
 * 403 is worth distinguishing: the difference between "you cannot do this" and
 * "something broke" is the difference between asking an administrator and
 * filing a bug.
 */
export function ErrorNote({ error }: { error: unknown }) {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status: number }).status
      : 0;
  // The server's own sentence beats anything guessed from a status code —
  // except for 401 and 403, where the useful advice is about the person
  // rather than the request.
  const fromServer =
    error && typeof error === "object" && "serverMessage" in error
      ? (error as { serverMessage?: string }).serverMessage
      : undefined;
  const message =
    status === 403
      ? "Your role does not allow this."
      : status === 401
        ? "Your session has expired. Sign in again."
        : (fromServer ?? "Something went wrong. Try again.");
  return (
    <p className="text-sm" style={{ color: "var(--color-danger)" }}>
      {message}
    </p>
  );
}

/** Invoice and quote states, coloured the way people read them. */
export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    paid: "var(--color-success)",
    open: "var(--color-info)",
    partial: "var(--color-warning)",
    overdue: "var(--color-danger)",
    draft: "var(--text-muted)",
    void: "var(--text-muted)",
  };
  return (
    <span
      className="rounded px-1.5 py-0.5 text-xs font-medium"
      style={{ color: tone[status] ?? "var(--text-muted)" }}
    >
      {status}
    </span>
  );
}

export interface Tab {
  id: string;
  label: string;
}

/**
 * Which tab an id actually selects.
 *
 * Separated from `Tabs` below and exported so the rule can be tested as
 * itself — see `tabs.test.ts`. It is also what a caller uses to work out
 * which panel to render, so the strip and the panel can never disagree about
 * which tab is showing.
 *
 * An id naming no tab falls back to the first rather than to nothing. Screens
 * keep the active tab in the URL, so a bookmark outlives the tab it names;
 * falling back to nothing would answer a saved link with a working tab strip
 * above an empty panel. No tabs at all is the one case that resolves to
 * nothing, because there is no tab to be honest about.
 */
export function activeTab(tabs: Tab[], active: string): Tab | undefined {
  return tabs.find((t) => t.id === active) ?? tabs[0];
}

/**
 * One tab strip, rather than one per screen that wants tabs.
 *
 * The caller owns the active id rather than this holding it in state, so a
 * detail screen can keep it in the URL and a deep link can open the tab it
 * names.
 *
 * `trailing` is for what the dashboard puts at the right-hand end of its own
 * strip — its "Arrange" button. Lifted with the markup rather than left
 * behind, because a strip that cannot carry it would have sent the dashboard
 * back to its own copy on the first screen that needed one.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  trailing,
}: {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  trailing?: ReactNode;
}) {
  const current = activeTab(tabs, active);
  return (
    <div className="flex flex-wrap items-center gap-1 border-b" style={border}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="-mb-px border-b-2 px-3 py-2 text-sm"
          style={
            tab.id === current?.id
              ? {
                  borderColor: "var(--color-brand-500)",
                  color: "var(--color-brand-500)",
                }
              : { borderColor: "transparent", ...muted }
          }
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </div>
  );
}

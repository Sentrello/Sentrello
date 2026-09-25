/**
 * The small set of primitives every screen is built from.
 *
 * Hand-written rather than pulled from a component library: the whole product
 * is tables, forms and money, and each of these is a few lines. Every one reads
 * the design tokens in index.css, so light and dark come free and the app can
 * be rethemed from one file.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { may } from "./api";
import { Icon } from "./icons";

export const border = { borderColor: "var(--border)" };
export const muted = { color: "var(--text-muted)" };

/**
 * Black or white on a colour somebody else chose.
 *
 * A tag's colour is the business's, not ours, so no fixed text colour is right
 * for all of them: `#1a1a1a` on the purple in the palette measures 4.39:1 —
 * under the line — while white on it is comfortable. Picking by luminance is
 * the only version that holds for a colour we have not seen.
 *
 * Relative luminance per WCAG, not a brightness eyeball: the two differ most
 * exactly in the middle of the range, which is where the palette lives.
 */
export function textOn(background: string): string {
  const hex = background.trim().replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (full.length !== 6) return "#1a1a1a";

  const channel = (pair: string): number => {
    const v = Number.parseInt(pair, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(full.slice(0, 2)) +
    0.7152 * channel(full.slice(2, 4)) +
    0.0722 * channel(full.slice(4, 6));

  /*
   * Pure black, not the near-black used elsewhere.
   *
   * `#1a1a1a` is the body colour and looks the same to the eye, and on the
   * palette's purple it measures **4.31:1** against black's 5.31 — the wrong
   * side of the line for the sake of a shade nobody can see. This is the one
   * place where the darker value is worth having.
   */
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
    ? "#000000"
    : "#ffffff";
}
/** A raised surface. Exported for `AuthShell`, which is a card before the kit's `Card` exists in the tree. */
export const raised = {
  background: "var(--surface-raised)",
  ...border,
};

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

/**
 * Money, short enough for a chart's scale: "$15k", "$1.2M".
 *
 * A chart axis has room for four characters and needs five labels of them. The
 * full figure belongs in the readout, where there is one of it and space for
 * it — `formatMoney` on an axis is "$15,000.00" five times over, overlapping.
 *
 * Built on `Intl` rather than by dividing and appending a symbol, so the
 * currency is the reader's and not a dollar sign written into a chart.
 */
export function briefMoney(cents: number, currency = formats.currency): string {
  if (!Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
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

/**
 * What a control needs before it is worth offering — `{ crm: ["delete"] }`.
 *
 * Named the way `requirePermission` names it at the route, deliberately: the
 * two say the same thing about the same button, and a caller copying the
 * route's own line is far likelier to get it right than one translating it.
 */
export type Needs = Record<string, string[]>;

/**
 * Disabled, with the reason on it, when the policy does not allow it.
 *
 * In the kit rather than at each call site, because there are several hundred
 * call sites and this is one decision. A control the person cannot use is
 * drawn dim and says why on hover, rather than being hidden — hiding teaches
 * nobody that the feature exists or that a colleague could do it for them,
 * and a screen that quietly loses half its buttons reads as broken.
 *
 * `title` rather than a live note: it is an explanation somebody goes looking
 * for once, not something that should shout on every screen.
 */
/**
 * The words, in one place.
 *
 * A checkbox has no primitive in this kit to hang `needs` on — there is no
 * `Checkbox`, and the handful that write disable themselves by asking `may`
 * directly. They were each carrying their own copy of this sentence, which is
 * how a screen ends up saying something a shade different from the screen
 * beside it about the same refusal.
 */
export const REFUSED = "Your role does not allow this.";

function blockedBy(needs: Needs | undefined): string | undefined {
  if (!needs) return undefined;
  const allowed = Object.entries(needs).every(([resource, actions]) =>
    actions.every((action) => may(resource, action)),
  );
  return allowed ? undefined : REFUSED;
}

/**
 * The same reason, said where somebody without a mouse will hear it.
 *
 * `title` draws a tooltip on hover and **says nothing at all to a screen
 * reader** — the point `ConfirmButton`'s `label` already makes a few hundred
 * lines down. A disabled control is out of the tab order too, so until this
 * the only person who could ever learn why a button was dead was the one
 * holding a pointer over it. On a product whose explicit decision is to dim
 * a control rather than hide it, *so that people learn the feature exists
 * and that a colleague could do it for them*, that is the explanation
 * reaching nobody it was written for.
 *
 * `aria-describedby` pointing at hidden text, rather than folding the reason
 * into the label: it is a description and not a name. A disabled control is
 * still reachable in a screen reader's browse mode, where the description is
 * read with it, and voice control still matches the button by the words
 * printed on it.
 */
function useBlockedReason(blocked: string | undefined) {
  const id = useId();
  return {
    describedBy: blocked ? { "aria-describedby": id } : undefined,
    note: blocked ? (
      <span id={id} className="sr-only">
        {blocked}
      </span>
    ) : null,
  };
}

export function Button({
  children,
  variant = "primary",
  needs,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  /** The permission this button's route asks for. Disabled without it. */
  needs?: Needs;
}) {
  const blocked = blockedBy(needs);
  const reason = useBlockedReason(blocked);
  const styles = {
    primary: {
      // The shade dark enough for white text on it: brand-500 measures 3.77:1
      // against the 4.5:1 AA asks, and this is every primary button in the
      // product.
      background: "var(--brand-on-white-text)",
      color: "var(--color-neutral-50)",
    },
    secondary: { background: "transparent", ...border, color: "var(--text)" },
    danger: { background: "var(--color-danger)", color: "white" },
  }[variant];

  return (
    <>
      <button
        type="button"
        {...rest}
        {...reason.describedBy}
        disabled={rest.disabled || blocked !== undefined}
        title={blocked ?? rest.title}
        className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
          variant === "secondary" ? "border" : ""
        } ${rest.className ?? ""}`}
        style={{ ...styles, ...rest.style }}
      >
        {children}
      </button>
      {reason.note}
    </>
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

export function Input({
  ref,
  needs,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  ref?: React.Ref<HTMLInputElement>;
  /**
   * The permission this box's own write asks for. Disabled without it.
   *
   * For a box whose `onChange` *is* the write — the idle timeout on the
   * compliance screen, a date that saves as it is typed — and not for one
   * that fills in a form somebody submits with a button. The button is the
   * write there, and refusing to let somebody type into a form they cannot
   * save is a worse way of telling them so.
   */
  needs?: Needs;
}) {
  const blocked = blockedBy(needs);
  const reason = useBlockedReason(blocked);
  return (
    <>
      <input
        {...props}
        {...reason.describedBy}
        ref={ref}
        disabled={props.disabled || blocked !== undefined}
        title={blocked ?? props.title}
        className={`${withWidth(props.className)} rounded border px-2 py-1.5 text-sm ${props.className ?? ""}`}
        style={{ ...raised, ...props.style }}
      />
      {reason.note}
    </>
  );
}

/**
 * The same box, taller.
 *
 * There was no such thing, so nine textareas across the product copied
 * `Input`'s look by hand — `--surface-raised`, `--border`, `--text`, the
 * padding, the radius — and two more copied nothing at all and therefore did
 * not match the form they sat in. A campaign body and a CSV import box, both
 * plain browser grey beside styled fields.
 *
 * Four rows by default, because the thing people type into one of these is a
 * paragraph and one row makes them scroll to reread their own sentence.
 */
export function Textarea({
  ref,
  rows = 4,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      {...props}
      ref={ref}
      rows={rows}
      className={`${withWidth(props.className)} rounded border px-2 py-1.5 text-sm ${props.className ?? ""}`}
      style={{ ...raised, ...props.style }}
    />
  );
}

/**
 * A secret that is not a login.
 *
 * An API key, a webhook signing secret, a bank token. They are masked for the
 * same reason a password is — somebody is often looking at the screen — and a
 * browser reasonably concludes from `type="password"` that it has found a
 * credential worth keeping.
 *
 * It then does two harmful things. It offers to save a Stripe secret key into
 * a password vault, where it syncs to a phone and a laptop and outlives the
 * key itself. And having saved it against this site, it *autofills* it into
 * the next password box it sees — which is the sign-in screen, so the owner of
 * the business is told their password is wrong and cannot get in.
 *
 * That is not hypothetical: it happened to James within a minute of pasting a
 * key, and the two symptoms looked like unrelated faults.
 *
 * So these fields say plainly that they are not credentials, in the several
 * dialects that matter — the standard attribute, plus the opt-outs 1Password
 * and LastPass read. `autocomplete="off"` alone is widely ignored on password
 * inputs; `new-password` is the value managers actually respect for "do not
 * fill this".
 */
export function SecretInput(
  props: React.InputHTMLAttributes<HTMLInputElement>,
) {
  return (
    <Input
      {...props}
      type="password"
      autoComplete="new-password"
      // Never a useful thing to correct, and a source of noise on a key.
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
    />
  );
}

export function Select({
  needs,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  /**
   * The permission the route behind this asks for, when choosing from it is
   * the action rather than a step towards one.
   *
   * A dropdown whose `onChange` fires a mutation is a control like any other,
   * and thirteen of them across the product were the one shape the gating
   * sweep could not touch — a status picker on a row, a policy picker beside
   * somebody's name. Choose an option, meet a 403.
   *
   * Not for a dropdown that only narrows a list or fills in a form. Those are
   * reads, and disabling a filter because somebody cannot write is nonsense.
   */
  needs?: Needs;
}) {
  const blocked = blockedBy(needs);
  const reason = useBlockedReason(blocked);
  return (
    <>
      <select
        {...props}
        {...reason.describedBy}
        disabled={props.disabled || blocked !== undefined}
        title={blocked ?? props.title}
        className={`${withWidth(props.className)} rounded border px-2 py-1.5 text-sm ${props.className ?? ""}`}
        style={{ ...raised, ...props.style }}
      />
      {reason.note}
    </>
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
      {/*
        `text-left` is not decoration. A dialog renders where it was written,
        and these are written inside the thing that opens them — a confirm in
        a table's actions column sits inside a `text-right` cell and inherited
        it, so the message came out ragged down the left while its own heading
        above it did not.
      */}
      <div className="p-4 text-left">{children}</div>
    </dialog>
  );
}

/**
 * Asking before something destructive, without the browser's own dialog.
 *
 * `window.confirm` was doing this in the Users console and nowhere else the
 * business looks. It blocks the whole tab, it cannot be styled, it ignores dark
 * mode, and on the screen that hands access around it made the most serious
 * actions the product has look like a script error. Settings had already grown
 * its own two-step button; this is that idea, once, so a third screen does not
 * invent a fourth version.
 *
 * The message says what will happen rather than "are you sure" — somebody
 * removing a person at half past four should not have to guess whether the
 * invoices they raised go with them. That copy already existed and is kept
 * verbatim; only the thing that shows it has changed.
 */
export function ConfirmButton({
  children,
  title,
  message,
  confirmLabel = "Yes, do it",
  danger = false,
  disabled = false,
  className,
  label,
  needs,
  variant,
  onConfirm,
}: {
  children: ReactNode;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
  /**
   * The permission the route behind this asks for. Without it the trigger is
   * disabled and the dialog never opens — being asked to confirm something
   * the server is going to refuse is worse than not being offered it.
   */
  needs?: Needs;
  /**
   * What the trigger is, for a trigger that is a picture.
   *
   * An icon on its own says nothing to somebody who has not met it and
   * nothing at all to a screen reader, and `title` here is the dialog's
   * heading rather than the button's. Only read when no `variant` is set,
   * since a full `Button` carries its own words.
   */
  label?: string;
  /** Set to render a full Button rather than the small inline link. */
  variant?: "primary" | "secondary" | "danger";
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const blocked = blockedBy(needs);
  const stopped = disabled || blocked !== undefined;
  const reason = useBlockedReason(blocked);

  return (
    <>
      {variant ? (
        // `needs` rather than the computed `blocked`: the full button already
        // knows how to be refused, and saying it twice is how the two drift.
        <Button
          variant={variant}
          needs={needs}
          disabled={disabled}
          onClick={() => setAsking(true)}
        >
          {children}
        </Button>
      ) : (
        <>
          <button
            type="button"
            disabled={stopped}
            title={blocked ?? label}
            aria-label={label}
            {...reason.describedBy}
            className={className ?? "text-xs link-muted"}
            style={danger ? { color: "var(--text-danger)" } : undefined}
            onClick={() => setAsking(true)}
          >
            {children}
          </button>
          {reason.note}
        </>
      )}
      <Dialog title={title} open={asking} onClose={() => setAsking(false)}>
        <div className="flex flex-col gap-(--gap-stack)">
          <p className="text-sm">{message}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              onClick={() => {
                setAsking(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/**
 * The heading above a panel or a section of one.
 *
 * Written three different ways before this existed — `text-sm` here, `text-lg`
 * there, and in one module an `<h2>` with no class at all, which renders at
 * whatever size the browser picks and looked nothing like the rest of the
 * product.
 *
 * The level is a prop because it is a different question from the size. A
 * heading inside a section that already has one must be an `h3` for anybody
 * reading with a screen reader, and hand-rolled headings picked the tag that
 * looked right instead, which is how a module ended up with `h3` where every
 * other module has `h2`.
 */
export function SectionHeading({
  children,
  level = 2,
  hint,
  trailing,
}: {
  children: ReactNode;
  level?: 2 | 3;
  hint?: ReactNode;
  /** Drawn at the right-hand end: a Close, an Export, a row of small links. */
  trailing?: ReactNode;
}) {
  const Tag = level === 3 ? "h3" : "h2";
  return (
    <div className="mb-(--gap-toolbar) flex items-baseline gap-(--gap-tight)">
      <Tag className="font-semibold text-sm">{children}</Tag>
      {hint ? (
        <span className="text-xs" style={muted}>
          {hint}
        </span>
      ) : null}
      {/*
       * Anything after the hint is pushed to the right-hand end. A panel with
       * a Close or an Export beside its title was being built by hand six
       * different ways — `mb-3 flex items-center justify-between` four times,
       * its `items-baseline` twin three more, and a version with no margin at
       * all six times. It is the same row as this one with something on the
       * end, so it is this row with something on the end.
       */}
      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </div>
  );
}

/**
 * A label and the number under it — the row across the top of every dashboard.
 *
 * Rebuilt by every module that has a dashboard, at four different sizes. The
 * size is the decision this exists to make once; the tone is the shop's, which
 * had already found that a figure sometimes has to read as good or bad while
 * its label stays as quiet as every other label on the row.
 */
export function StatFigure({
  label,
  value,
  tone = "plain",
  hint,
  size = "md",
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "plain" | "good" | "bad";
  hint?: ReactNode;
  /** "md" (default) is the four-tile dashboard row's text-2xl. "sm" is for a
   * denser grid, where blowing up small numbers that large wrecks the layout. */
  size?: "sm" | "md";
}) {
  const colour =
    tone === "good"
      ? { color: "var(--text-success)" }
      : tone === "bad"
        ? { color: "var(--text-danger)" }
        : undefined;
  return (
    <div>
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <p
        className={`money mt-1 font-semibold ${size === "sm" ? "text-sm" : "text-2xl"}`}
        style={colour}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-xs" style={muted}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The root of a screen, and the reason a screen no longer chooses its own.
 *
 * Forty-six route files used four different root wrappers between them —
 * `space-y-4`, `grid gap-4`, `grid gap-6`, `flex gap-6` — and six vertical
 * rhythms across the app, `space-y-4` sixty times against `space-y-1`
 * forty-three. None of that was a decision; it was whatever the last screen
 * was copied from.
 *
 * `width` is the one thing a screen legitimately differs on. A list wants the
 * window; a settings form at full width is a line of text a metre long, and
 * only two of the forty-six constrained themselves.
 */
export function Page({
  children,
  width = "full",
  className = "",
}: {
  children: ReactNode;
  /** `full` for lists and dashboards, `prose` for forms and settings. */
  width?: "full" | "prose";
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-(--gap-stack) ${width === "prose" ? "max-w-3xl" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The row of controls above a list.
 *
 * Fifteen distinct spellings did this job — `mt-3 flex flex-wrap items-end
 * gap-2` eight times, `mt-3 flex flex-wrap gap-2` four, and eleven one-offs.
 * The variation carried no meaning: every one of them was a search box, some
 * filters and a button.
 *
 * `items-end` rather than `items-center`, because a toolbar mixes bare
 * controls with labelled ones and it is the baselines that should line up,
 * not the middles of boxes with different heights.
 */
export function Toolbar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-end gap-(--gap-toolbar) ${className}`}
    >
      {children}
    </div>
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
  const padding = /(^|\s)p-/.test(className) ? "" : "p-(--pad-panel)";
  return (
    <div className={`rounded-md border ${padding} ${className}`} style={raised}>
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
            {headers.map((h, i) => {
              const label = typeof h === "string" ? h : h.label;
              const money = typeof h !== "string" && h.money;
              return (
                <th
                  // By position, not by label: a checkbox column and an
                  // actions column both carry "" and collided as React keys,
                  // which logged as a console error on every screen with
                  // both. `headers` is a literal passed by the caller and
                  // never reordered, so the index is stable.
                  // biome-ignore lint/suspicious/noArrayIndexKey: order is fixed by the caller
                  key={i}
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
      {/*
        A div, not a paragraph. `children` is a ReactNode and callers pass
        blocks — a paragraph of their own, a link, a button offering the thing
        that is missing — and a <p> inside a <p> is invalid markup the browser
        silently reshapes, which is how the Forms empty state came to have its
        explanation sitting outside the box that was supposed to hold it.
      */}
      {children ? (
        <div className="mt-1 text-sm" style={muted}>
          {children}
        </div>
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
  return <Warning>{message}</Warning>;
}

/**
 * A sentence in the colour of something being wrong.
 *
 * `ErrorNote` is for an error object and decides the words itself. This is for
 * words we chose — "give the formula a name first", "records are past their
 * deletion date and the purge is not running", "that automation is gone".
 *
 * They were the same four lines of markup written out 23 times, and the reason
 * is worth keeping: `ErrorNote` reads its sentence off `serverMessage`, so a
 * hand-made `new Error("give it a name")` or a plain string falls straight
 * through to "Something went wrong. Try again." — the one message that helps
 * nobody, covering the one that would have. Making `ErrorNote` fall back to
 * `error.message` instead would print "POST /api/x failed" to customers across
 * 375 call sites, so the answer is a second door rather than a wider one.
 */
export function Warning({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  // ui-drift-ignore: the primitive the rule points at
  return (
    <p
      className={`text-sm ${className}`}
      style={{ color: "var(--text-danger)" }}
    >
      {children}
    </p>
  );
}

/** Invoice and quote states, coloured the way people read them. */
export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    paid: "var(--text-success)",
    open: "var(--text-info)",
    partial: "var(--text-warning)",
    overdue: "var(--text-danger)",
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
  /** A count, when the strip is also a summary — what invoices uses it for. */
  badge?: ReactNode;
}

/**
 * Which tab an id actually selects.
 *
 * Separated from `Tabs` below and exported so the rule can be tested as
 * itself — see `tabs.test.tsx`. It is also what a caller uses to work out
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
                  // The border may be brand-500; the *text* may not.
                  // brand-500 on the light surface measures 3.78:1 against the
                  // 4.5:1 AA asks for text this size, so the selected tab —
                  // the one word on the strip that says where you are — was
                  // the hardest thing on it to read. A border is a graphical
                  // object at 3:1 and passes; text is not.
                  borderColor: "var(--color-brand-500)",
                  color: "var(--text-brand)",
                }
              : { borderColor: "transparent", ...muted }
          }
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge !== undefined ? (
            <span className="ml-1.5 text-xs tabular-nums" style={muted}>
              {tab.badge}
            </span>
          ) : null}
        </button>
      ))}
      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </div>
  );
}

export { PageActions, PageSubtitle } from "./page-header";
export {
  CustomFieldEditor,
  CustomFields,
  CustomValues,
} from "./custom-fields";

/**
 * A row's "…" menu, drawn where nothing can clip it.
 *
 * ## The bug this exists to kill
 *
 * James, 22 September: *"There is a UI issue when clicking the 3 dots to add
 * questions and other options."* On the CRM's forms list, and on three other
 * screens with the same control, for one reason that has nothing to do with
 * any of them.
 *
 * `Table` above wraps every table in `<div className="overflow-x-auto">`, so
 * a narrow screen scrolls sideways instead of bursting the layout. That is
 * right, and it is also a clipping context — and CSS says a box that is not
 * `visible` on one axis cannot stay `visible` on the other, so `overflow-x:
 * auto` quietly makes the vertical axis `auto` too. An absolutely-positioned
 * panel hanging off the last row is therefore cut off at the table's bottom
 * edge, and a menu on the right-hand column is cut off sideways as well.
 *
 * Every fix that stays inside the table is worse than the bug. Turning
 * overflow off loses the horizontal scroll that narrow screens need; raising
 * the z-index does nothing, because clipping is not a stacking question and
 * no z-index has ever escaped an `overflow: hidden`.
 *
 * So the panel is not in the table. It is portalled to `document.body` and
 * positioned `fixed` against the trigger's own rectangle, which puts it
 * outside every ancestor that could clip it, on any screen, for good.
 *
 * ## Why it closes on scroll
 *
 * A fixed panel measured once does not follow the thing it belongs to. It
 * could be re-measured on every scroll frame; closing is less code and is
 * what the platform's own menus do. Somebody who scrolls has moved on.
 *
 * ## Flipping
 *
 * A menu on the last row of a long table has no room beneath it, which is
 * exactly where this was first noticed. If the space below is too small it
 * opens upward instead, and the measurement is against the viewport rather
 * than the table, because the viewport is now what constrains it.
 */
/**
 * One line of a row menu — Void, Credit, Send, Delete.
 *
 * A component rather than a class name, because the class name could not
 * carry a permission. Invoices and quotes keep their whole vocabulary of
 * destructive and money-moving actions in these menus, and every one of them
 * was a bare `<button className="menu-item">` that the policy could not
 * reach: a bookkeeper opened the menu, pressed Void, and found out from a
 * 403.
 *
 * Disabled with the reason on hover, the same as `Button`, rather than
 * removed from the menu. A menu that is a different length for different
 * people is a menu nobody can be told how to use.
 */
export function MenuItem({
  children,
  needs,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { needs?: Needs }) {
  const blocked = blockedBy(needs);
  const reason = useBlockedReason(blocked);
  return (
    <>
      <button
        type="button"
        {...rest}
        {...reason.describedBy}
        disabled={rest.disabled || blocked !== undefined}
        title={blocked ?? rest.title}
        className={`menu-item ${rest.className ?? ""}`}
      >
        {children}
      </button>
      {reason.note}
    </>
  );
}

export function RowMenu({
  label,
  children,
  open: controlled,
  onOpenChange,
}: {
  /** For the trigger's accessible name: "More for Contact us". */
  label: string;
  /** Given a `close` to call, so an item can act and dismiss in one handler. */
  children: (close: () => void) => ReactNode;
  /**
   * Optional, for a menu whose owner also closes it from somewhere the render
   * prop cannot reach — a mutation's `onSuccess`, which is where invoices and
   * quotes dismiss theirs after the server has agreed. Pass both or neither.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), [setOpen]);

  // Measure after paint, so the panel's own height is known and the decision
  // to flip is made against a real number rather than an estimate.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const button = trigger.current.getBoundingClientRect();
    const height = panel.current?.offsetHeight ?? 0;
    const below = window.innerHeight - button.bottom;
    const flip = height > 0 && below < height + 8 && button.top > below;
    setAt({
      top: flip ? button.top - height - 6 : button.bottom + 6,
      right: window.innerWidth - button.right,
    });
  }, [open]);

  /*
   * Into the panel, not past it.
   *
   * The panel is drawn through a portal on `document.body`, so it sits at the
   * end of the document however near the trigger it looks. Tab from the
   * trigger therefore went to the next row rather than into the menu, and the
   * only way to reach Void or Delete without a mouse was to tab through every
   * remaining control on the screen. Escape and returning focus to the
   * trigger were already here; this is the other half of them.
   */
  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLElement>("button:not([disabled])")
      ?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        trigger.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target)) return;
      if (trigger.current?.contains(target)) return;
      close();
    };
    // Capture, because a scroller between here and the window may stop the
    // event bubbling — and the table this sits in is one.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="link-muted px-1"
        aria-label={`More for ${label}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panel}
              className="menu-panel"
              /*
               * A group of buttons, said plainly, rather than `role="menu"`.
               *
               * It claimed that role for months and axe calls the result
               * critical: `menu` may only contain `menuitem`, and every one
               * of these is a `<button>`. The screen walk never saw it
               * because it never opens a menu — 234 screens green with a
               * critical violation on the most-used control in the product.
               *
               * The fix is not to relabel the buttons. `menuitem` promises a
               * keyboard model this does not implement — arrows, Home, End,
               * typeahead — and takes the items out of the tab sequence to
               * pay for it, so claiming it would leave a screen-reader user
               * worse off than the honest answer. `MenuItem` is also used
               * outside a menu, on half a dozen screens, where a `menuitem`
               * with no menu around it is a critical violation of its own.
               *
               * So: no role at all. A plain box of buttons, each announced by
               * the words on it, reached by the focus move below. `group`
               * with a label was tried and is worse for the trouble — the
               * trigger already says "More for Contact us", the name adds
               * nothing a second time, and the linter then argues for a
               * `<fieldset>`, which is for form controls and would bring its
               * own styling to a floating panel.
               */
              style={{
                position: "fixed",
                // Until the first measurement lands the panel is placed off
                // screen rather than at 0,0 — one frame in the top-left
                // corner is a flicker somebody notices every single time.
                top: at ? at.top : -9999,
                right: at ? at.right : 0,
                zIndex: 60,
              }}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

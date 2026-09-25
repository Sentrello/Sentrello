import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { ChoiceOptionsInput } from "../lib/choice-options";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Select,
  muted,
} from "../lib/ui";

/**
 * Building the form.
 *
 * Fields could only be defined through the API, which made every form the same
 * three boxes the default shipped with. A quote request needs to ask what the
 * job is; a newsletter sign-up needs one line and no phone number. Neither was
 * possible from the screen.
 *
 * Deliberately not a drag-and-drop canvas. The thing being built is a short
 * list of questions, and a list is what people can reason about — a canvas
 * would be more to build, more to break, and no easier to use for six fields.
 */

export interface ChoiceInfo {
  title?: string;
  body?: string;
  href?: string;
  hrefLabel?: string;
}

export interface FormField {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  /** The answers a choice field offers — dropdown or radio. Ignored by the rest. */
  options?: string[];
  /**
   * What a visitor is told once they have chosen, keyed by the answer.
   *
   * Only drawn for the all-shown kind, where the answers are on the page and
   * the panel can sit under them. A visitor who picks "Get support" can be
   * pointed at the documentation before they type a word, and the enquiry that
   * never arrives is the cheapest one to answer. Every part is optional, so a
   * form that wants plain radios keeps plain radios.
   */
  info?: Record<string, ChoiceInfo>;
  /**
   * Half a row, so two fields sit side by side.
   *
   * Name beside email, town beside postcode. Off by default, because a form
   * of full-width fields is the thing that always works and pairing is a
   * decision about this particular form.
   */
  half?: boolean;
}

const TYPES = [
  { id: "text", label: "Text" },
  { id: "email", label: "Email" },
  { id: "tel", label: "Phone" },
  { id: "textarea", label: "Long text" },
  { id: "number", label: "Number" },
  { id: "url", label: "Web address" },
  { id: "select", label: "Choice (dropdown)" },
  /*
   * The same data as a dropdown, shown all at once.
   *
   * Worth being a separate type rather than a display flag, because the
   * choice between them is a real one and it belongs to whoever builds the
   * form. Four options a visitor should read before answering want radios; a
   * list of thirty countries wants a dropdown. Asked for by James on
   * 22 September for the contact form, where the answer routes the enquiry
   * and picking the first one by accident sends it to the wrong place.
   */
  { id: "radio", label: "Choice (all shown)" },
  // A native date input, so the visitor gets their own device's picker rather
  // than a script we would have to ship, style and keep accessible.
  { id: "date", label: "Date" },
  /*
   * A file, and only ever a PDF.
   *
   * One format because the checks are per-format: a PDF can be read for the
   * things a document has no business doing, and "any file" cannot. A CV, a
   * signed quote, a photograph somebody exported — all of them arrive as a
   * PDF, and the ones that do not are better asked for by email than written
   * unchecked to the instance's disk.
   */
  { id: "file", label: "File (PDF)" },
];

/**
 * The panels that still belong to an answer.
 *
 * Rename a choice and its panel has nothing to open under, so it goes. Keeping
 * it would leave a form carrying text nobody can see and nobody can delete.
 */
export function kept(
  info: Record<string, ChoiceInfo> | undefined,
  options: string[],
): Record<string, ChoiceInfo> | undefined {
  if (!info) return undefined;
  const next: Record<string, ChoiceInfo> = {};
  for (const option of options) if (info[option]) next[option] = info[option];
  return Object.keys(next).length > 0 ? next : undefined;
}

/** One answer's panel, edited a part at a time, emptied back to nothing. */
export function withInfo(
  field: FormField,
  option: string,
  patch: ChoiceInfo,
): FormField {
  const merged: ChoiceInfo = { ...field.info?.[option], ...patch };
  for (const key of Object.keys(merged) as (keyof ChoiceInfo)[]) {
    if (!merged[key]?.trim()) delete merged[key];
  }
  const info = { ...field.info };
  if (Object.keys(merged).length > 0) info[option] = merged;
  else delete info[option];
  return {
    ...field,
    info: Object.keys(info).length > 0 ? info : undefined,
  };
}

/**
 * The name a submission is stored under, derived from the label.
 *
 * People type "What needs doing?"; the payload key has to be usable, stable
 * and unique. Deriving it means nobody is asked to invent an identifier, and
 * the submissions table stays readable to whoever reads it later.
 */
export function fieldName(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field";
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    if (!taken.includes(`${base}_${i}`)) return `${base}_${i}`;
  }
  return `${base}_${Date.now()}`;
}

/**
 * One field moved by `by` places, order being the only thing that says what a
 * visitor reads first.
 *
 * Its own exported function because the version inside the component could not
 * be tested — and the reordering it does is the same for every field type,
 * which is worth being able to prove rather than assert. A Choice carries its
 * answers and their panels on the field object itself, so it travels whole.
 *
 * Out of bounds returns the same array, not a copy: the caller is a state
 * setter, and handing back an identical-but-new array re-renders the list for
 * nothing.
 */
export function moved(
  rows: FormField[],
  index: number,
  by: number,
): FormField[] {
  const target = index + by;
  if (target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  const [item] = next.splice(index, 1);
  if (item) next.splice(target, 0, item);
  return next;
}

export function FormBuilder({
  formId,
  fields,
  tag,
  style,
  redirectUrl,
  notifyEmail,
  onDone,
}: {
  formId: string;
  fields: FormField[];
  tag: string | null;
  style: { accent?: string; radius?: string } | null;
  redirectUrl: string | null;
  notifyEmail: string | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<FormField[]>(fields.length ? fields : []);
  const [formTag, setFormTag] = useState(tag ?? "");
  const [accent, setAccent] = useState(style?.accent ?? "");
  const [radius, setRadius] = useState(style?.radius ?? "");
  const [label, setLabel] = useState("");
  const [type, setType] = useState("text");
  const [notify, setNotify] = useState(notifyEmail ?? "");
  const [redirect, setRedirect] = useState(redirectUrl ?? "");

  const add = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setRows((r) => [
      ...r,
      {
        name: fieldName(
          trimmed,
          r.map((f) => f.name),
        ),
        label: trimmed,
        type,
        required: false,
      },
    ]);
    setLabel("");
    setType("text");
  };

  const move = (index: number, by: number) =>
    setRows((r) => moved(r, index, by));

  const save = useMutation({
    mutationFn: () =>
      api(`/api/forms/${formId}`, {
        method: "PATCH",
        body: JSON.stringify({
          fields: rows,
          tag: formTag.trim() || null,
          // Empty means nobody is told, and the visitor sees our thank-you
          // page: both are real settings, so both are sent as null rather
          // than left out.
          notifyEmail: notify.trim() || null,
          redirectUrl: redirect.trim() || null,
          // Only sent when set: an empty object would overwrite a style
          // somebody configured with nothing.
          style:
            accent.trim() || radius.trim()
              ? {
                  ...(accent.trim() ? { accent: accent.trim() } : {}),
                  ...(radius.trim() ? { radius: radius.trim() } : {}),
                }
              : null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["forms"] });
      onDone();
    },
  });

  return (
    <Card>
      <p className="mb-2 font-medium">Questions this form asks</p>

      {rows.length === 0 ? (
        <p className="text-sm" style={muted}>
          No fields yet. Add the first one below.
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((f, i) => (
            <li
              key={f.name}
              className="flex flex-wrap items-center gap-2 border-t py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <span className="flex-1">
                {f.label}
                {/* A choice with no answers offers nothing, whichever way it
                    is drawn, so the options are edited here rather than on a
                    second screen somebody has to know to open. */}
                {f.type === "select" || f.type === "radio" ? (
                  <ChoiceOptionsInput
                    className="mt-1 text-xs"
                    options={f.options ?? []}
                    label={f.label}
                    onChange={(options) =>
                      setRows((r) =>
                        r.map((x, j) =>
                          i === j
                            ? { ...x, options, info: kept(x.info, options) }
                            : x,
                        ),
                      )
                    }
                  />
                ) : null}
                {/* The panel each answer opens, edited beside the answer it
                    belongs to. Folded away by default: most forms want none
                    of this, and a form that wants it wants it on one choice. */}
                {f.type === "radio" && (f.options ?? []).length > 0
                  ? (f.options ?? []).map((option) => (
                      <details key={option} className="mt-1">
                        <summary
                          className="cursor-pointer text-xs"
                          style={muted}
                        >
                          What “{option}” shows
                        </summary>
                        <div className="mt-1 grid gap-1 sm:grid-cols-2">
                          <Input
                            className="text-xs"
                            value={f.info?.[option]?.title ?? ""}
                            placeholder="What you get"
                            aria-label={`Heading shown for ${option}`}
                            onChange={(e) =>
                              setRows((r) =>
                                r.map((x, j) =>
                                  i === j
                                    ? withInfo(x, option, {
                                        title: e.target.value,
                                      })
                                    : x,
                                ),
                              )
                            }
                          />
                          <Input
                            className="text-xs"
                            value={f.info?.[option]?.body ?? ""}
                            placeholder="A sentence the visitor reads before typing"
                            aria-label={`Detail shown for ${option}`}
                            onChange={(e) =>
                              setRows((r) =>
                                r.map((x, j) =>
                                  i === j
                                    ? withInfo(x, option, {
                                        body: e.target.value,
                                      })
                                    : x,
                                ),
                              )
                            }
                          />
                          <Input
                            className="text-xs"
                            value={f.info?.[option]?.href ?? ""}
                            placeholder="https://… (optional link)"
                            aria-label={`Link shown for ${option}`}
                            onChange={(e) =>
                              setRows((r) =>
                                r.map((x, j) =>
                                  i === j
                                    ? withInfo(x, option, {
                                        href: e.target.value,
                                      })
                                    : x,
                                ),
                              )
                            }
                          />
                          <Input
                            className="text-xs"
                            value={f.info?.[option]?.hrefLabel ?? ""}
                            placeholder="What the link says"
                            aria-label={`Link text shown for ${option}`}
                            onChange={(e) =>
                              setRows((r) =>
                                r.map((x, j) =>
                                  i === j
                                    ? withInfo(x, option, {
                                        hrefLabel: e.target.value,
                                      })
                                    : x,
                                ),
                              )
                            }
                          />
                        </div>
                      </details>
                    ))
                  : null}
              </span>
              <span className="text-xs" style={muted}>
                {TYPES.find((t) => t.id === f.type)?.label ?? f.type}
              </span>
              {/* Side by side, for the pairs that read as one answer. */}
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={f.half ?? false}
                  onChange={(e) =>
                    setRows((r) =>
                      r.map((x, j) =>
                        i === j ? { ...x, half: e.target.checked } : x,
                      ),
                    )
                  }
                />
                Half width
              </label>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(f.required)}
                  onChange={(e) =>
                    setRows((r) =>
                      r.map((x, j) =>
                        i === j ? { ...x, required: e.target.checked } : x,
                      ),
                    )
                  }
                />
                required
              </label>
              {/* Order is what somebody reads the form in, so it has to be
                  changeable without deleting and re-adding. */}
              {/* Disabled at the ends, like every other reorder in the app.
                  
                  They were live everywhere, so the first field's ↑ was a
                  button you could hover, click, and get nothing from — no
                  movement, no message, no reason. On a Choice that reads as
                  the field being stuck, because a Choice row is tall enough
                  that its buttons wrap to the bottom of a block and there is
                  nothing else on screen to tell you the click landed. */}
              <button
                type="button"
                aria-label={`Move ${f.label} up`}
                className="px-1 text-xs"
                style={muted}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${f.label} down`}
                className="px-1 text-xs"
                style={muted}
                disabled={i === rows.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="px-1 text-xs"
                style={{ color: "var(--text-danger)" }}
                onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Add a question">
          <Input
            value={label}
            placeholder="What needs doing?"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </Field>
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={add} disabled={!label.trim()}>
          Add
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field
          label="Tag"
          hint="Which form a submission came from. Every form collects a name."
        >
          <Input
            value={formTag}
            placeholder="footer"
            onChange={(e) => setFormTag(e.target.value)}
          />
        </Field>
        <Field label="Accent colour" hint="Hex, to match the site.">
          <Input
            value={accent}
            placeholder="#c4470f"
            onChange={(e) => setAccent(e.target.value)}
          />
        </Field>
        <Field label="Corner radius" hint="e.g. 6px.">
          <Input
            value={radius}
            placeholder="6px"
            onChange={(e) => setRadius(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label="Tell somebody"
          hint="Emailed when this form is filled in. Blank tells nobody."
        >
          <Input
            type="email"
            value={notify}
            placeholder="enquiries@yourbusiness.com"
            onChange={(e) => setNotify(e.target.value)}
          />
        </Field>
        <Field
          label="After submitting, send them to"
          hint="Your own thank-you page. Blank shows ours."
        >
          <Input
            type="url"
            value={redirect}
            placeholder="https://yourbusiness.com/thanks"
            onChange={(e) => setRedirect(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 flex gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save form"}
        </Button>
        <button type="button" className="text-sm link-muted" onClick={onDone}>
          Cancel
        </button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

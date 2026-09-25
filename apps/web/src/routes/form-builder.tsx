import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { api } from "../lib/api";
import { ChoiceOptionsInput } from "../lib/choice-options";
import {
  Button,
  ConfirmButton,
  ErrorNote,
  Field,
  Input,
  Row,
  SectionHeading,
  Select,
  Table,
  Toolbar,
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
  /** The one question whose per-answer panels are open, if any. */
  const [showing, setShowing] = useState<string | null>(null);

  /**
   * Whether closing now would lose anything.
   *
   * Compared against what was handed in rather than tracked with a flag: a
   * flag says "somebody typed", and somebody who types a letter and deletes it
   * has changed nothing. The fields go through JSON because they are a nested
   * structure and this is a dozen rows, not a document.
   */
  const dirty =
    JSON.stringify(rows) !== JSON.stringify(fields) ||
    formTag !== (tag ?? "") ||
    accent !== (style?.accent ?? "") ||
    radius !== (style?.radius ?? "") ||
    notify !== (notifyEmail ?? "") ||
    redirect !== (redirectUrl ?? "");

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
    <div className="flex flex-col gap-(--gap-stack)">
      <SectionHeading level={3}>Questions this form asks</SectionHeading>

      {rows.length === 0 ? (
        <p className="text-sm" style={muted}>
          No questions yet. Add the first one below.
        </p>
      ) : (
        /*
         * A table, because this is a table: every question has the same four
         * facts about it and a reader should be able to run an eye down any
         * one of them.
         *
         * It was a `flex-wrap` list item. Controls reflowed wherever they
         * landed, every row was a different height depending on its type, and
         * a five-answer Choice nested five collapsibles of four unlabelled
         * inputs — twenty controls inside one line of a list.
         */
        <Table
          headers={[
            "Question",
            "Answered with",
            "Width",
            "Required",
            "Order",
            "",
          ]}
        >
          {rows.map((f, i) => (
            <Fragment key={f.name}>
              <Row>
                <td className="py-2">{f.label}</td>
                <td>
                  {/* Changeable, at last. The type was fixed at creation, so
                      asking for an email address as a text box meant deleting
                      the question and writing it again. */}
                  <Select
                    className="text-sm"
                    aria-label={`How ${f.label} is answered`}
                    value={f.type}
                    onChange={(e) =>
                      setRows((r) =>
                        r.map((x, j) =>
                          i === j ? { ...x, type: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    {TYPES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </td>
                <td>
                  <label className="flex items-center gap-(--gap-tight) text-xs">
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
                    Half
                  </label>
                </td>
                <td>
                  <label className="flex items-center gap-(--gap-tight) text-xs">
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
                    Required
                  </label>
                </td>
                <td>
                  {/* Disabled at the ends, like every other reorder in the
                      app. They were live everywhere, so the first question's
                      ↑ was a button you could press and get nothing from. */}
                  <div className="flex items-center gap-(--gap-tight)">
                    <button
                      type="button"
                      aria-label={`Move ${f.label} up`}
                      className="px-1 text-xs"
                      style={muted}
                      disabled={i === 0}
                      onClick={() => setRows((r) => moved(r, i, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${f.label} down`}
                      className="px-1 text-xs"
                      style={muted}
                      disabled={i === rows.length - 1}
                      onClick={() => setRows((r) => moved(r, i, 1))}
                    >
                      ↓
                    </button>
                  </div>
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="px-1 text-xs"
                    style={{ color: "var(--text-danger)" }}
                    onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                </td>
              </Row>

              {/*
               * A choice's answers, on their own line under the question.
               *
               * They belong to the question, so they sit under it rather than
               * in a cell of their own that is empty on every other row.
               */}
              {f.type === "select" || f.type === "radio" ? (
                <Row>
                  <td colSpan={6} className="pb-2">
                    <ChoiceOptionsInput
                      className="text-xs"
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
                    {/*
                     * The panel each answer opens, behind one link.
                     *
                     * Most forms want none of this, and a form that wants it
                     * wants it on one question — so twenty controls were being
                     * drawn on every radio row for a feature almost nobody
                     * uses. One row opens at a time, which is the other half
                     * of the same problem.
                     */}
                    {f.type === "radio" && (f.options ?? []).length > 0 ? (
                      <div className="mt-(--gap-tight)">
                        <button
                          type="button"
                          className="text-xs link-muted"
                          aria-expanded={showing === f.name}
                          onClick={() =>
                            setShowing(showing === f.name ? null : f.name)
                          }
                        >
                          {showing === f.name
                            ? "Hide"
                            : "What each answer shows"}
                        </button>
                        {showing === f.name ? (
                          <div className="mt-(--gap-toolbar) flex flex-col gap-(--gap-toolbar)">
                            {(f.options ?? []).map((option) => (
                              <div
                                key={option}
                                className="border-line border-t pt-(--gap-toolbar)"
                              >
                                <p className="mb-(--gap-tight) text-xs font-medium">
                                  “{option}”
                                </p>
                                <div className="grid gap-(--gap-tight) sm:grid-cols-2">
                                  <Field label="Heading">
                                    <Input
                                      className="text-xs"
                                      value={f.info?.[option]?.title ?? ""}
                                      placeholder="What you get"
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
                                  </Field>
                                  <Field label="Sentence">
                                    <Input
                                      className="text-xs"
                                      value={f.info?.[option]?.body ?? ""}
                                      placeholder="What the visitor reads before typing"
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
                                  </Field>
                                  <Field label="Link">
                                    <Input
                                      className="text-xs"
                                      value={f.info?.[option]?.href ?? ""}
                                      placeholder="https://…"
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
                                  </Field>
                                  <Field label="What the link says">
                                    <Input
                                      className="text-xs"
                                      value={f.info?.[option]?.hrefLabel ?? ""}
                                      placeholder="Read the guide"
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
                                  </Field>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </Row>
              ) : null}
            </Fragment>
          ))}
        </Table>
      )}

      {/* Both controls labelled. The type select had no label at all, which
          left three boxes of three different heights sitting on one baseline
          with a caption over only the first of them. */}
      <Toolbar>
        <Field label="Add a question">
          <Input
            value={label}
            placeholder="What needs doing?"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </Field>
        <Field label="Answered with">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" onClick={add} disabled={!label.trim()}>
          Add
        </Button>
      </Toolbar>

      {/*
       * Two headings over what were two unlabelled grids.
       *
       * Five boxes ran together under the question list — a tag, a colour, a
       * radius, an email and a URL — with nothing saying that the first three
       * change what a visitor sees and the last two change what happens after
       * they press the button. They are two different questions and they now
       * look like two different questions.
       */}
      <SectionHeading level={3} hint="What a visitor sees on your own site.">
        How it looks
      </SectionHeading>
      <div className="grid gap-(--gap-toolbar) sm:grid-cols-3">
        <Field label="Accent colour" hint="The button and the focus ring.">
          <Toolbar>
            {/*
             * A colour input beside the text, not instead of it. Somebody
             * matching a site has the hex on their clipboard and wants to
             * paste it; somebody choosing wants to see the colour. This was a
             * free-text box with neither — no picker, no swatch, and no way to
             * know whether what you typed was even a colour until the form was
             * live on a customer's website.
             */}
            <input
              type="color"
              aria-label="Pick the accent colour"
              className="h-9 w-9 shrink-0 cursor-pointer rounded-sm border border-line bg-transparent p-1"
              value={/^#[0-9a-f]{6}$/i.test(accent) ? accent : "#c4470f"}
              onChange={(e) => setAccent(e.target.value)}
            />
            <Input
              value={accent}
              placeholder="#c4470f"
              onChange={(e) => setAccent(e.target.value)}
            />
          </Toolbar>
        </Field>
        <Field label="Corner radius" hint="e.g. 6px, or 0 for square.">
          <Input
            value={radius}
            placeholder="6px"
            onChange={(e) => setRadius(e.target.value)}
          />
        </Field>
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
      </div>

      <SectionHeading level={3} hint="Once somebody presses the button.">
        What happens next
      </SectionHeading>
      <div className="grid gap-(--gap-toolbar) sm:grid-cols-2">
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

      {save.error ? <ErrorNote error={save.error} /> : null}

      {/*
       * Nothing here is saved until this button.
       *
       * Every edit, every checkbox, every reorder and every removal is local
       * state, so closing the dialog threw the lot away without a word. It
       * still does, but now it says so first — and only when there is
       * something to lose, because a confirm on an untouched form is a dialog
       * that teaches people to dismiss dialogs.
       */}
      <Toolbar>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save form"}
        </Button>
        {dirty ? (
          <ConfirmButton
            variant="secondary"
            title="Throw away these changes?"
            message="The questions and settings you have changed here have not been saved. Closing now loses them."
            confirmLabel="Throw them away"
            danger
            onConfirm={onDone}
          >
            Cancel
          </ConfirmButton>
        ) : (
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        )}
      </Toolbar>
    </div>
  );
}

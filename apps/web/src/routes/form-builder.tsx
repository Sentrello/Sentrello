import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
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

export interface FormField {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  /** The answers a "choice" field offers. Ignored by every other type. */
  options?: string[];
}

const TYPES = [
  { id: "text", label: "Text" },
  { id: "email", label: "Email" },
  { id: "tel", label: "Phone" },
  { id: "textarea", label: "Long text" },
  { id: "number", label: "Number" },
  { id: "url", label: "Web address" },
  { id: "select", label: "Choice" },
  // A native date input, so the visitor gets their own device's picker rather
  // than a script we would have to ship, style and keep accessible.
  { id: "date", label: "Date" },
];

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

  const move = (index: number, by: number) => {
    setRows((r) => {
      const next = [...r];
      const target = index + by;
      if (target < 0 || target >= next.length) return r;
      const [item] = next.splice(index, 1);
      if (item) next.splice(target, 0, item);
      return next;
    });
  };

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
                {/* A choice with no answers is a dropdown offering nothing, so
                    the options are edited here rather than on a second screen
                    somebody has to know to open. */}
                {f.type === "select" ? (
                  <Input
                    className="mt-1 text-xs"
                    value={(f.options ?? []).join(", ")}
                    placeholder="Sales, Support, Accounts"
                    aria-label={`Choices for ${f.label}`}
                    onChange={(e) =>
                      setRows((r) =>
                        r.map((x, j) =>
                          i === j
                            ? {
                                ...x,
                                options: e.target.value
                                  .split(",")
                                  .map((o) => o.trim())
                                  .filter(Boolean),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                ) : null}
              </span>
              <span className="text-xs" style={muted}>
                {TYPES.find((t) => t.id === f.type)?.label ?? f.type}
              </span>
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
              <button
                type="button"
                aria-label={`Move ${f.label} up`}
                className="px-1 text-xs"
                style={muted}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${f.label} down`}
                className="px-1 text-xs"
                style={muted}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="px-1 text-xs"
                style={{ color: "var(--color-danger)" }}
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
            placeholder="#0f766e"
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

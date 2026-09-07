import type { CustomField } from "./crm-settings";
import {
  Button,
  Card,
  Field,
  Input,
  Select,
  border,
  formatDate,
  muted,
} from "./ui";

/**
 * The fields a business adds for itself, on a form.
 *
 * One component for contacts, companies and deals: the three forms would
 * otherwise each grow their own copy, and the third one would render dates as
 * text boxes because somebody forgot.
 */
export function CustomFields({
  fields,
  values,
  onChange,
}: {
  fields: CustomField[];
  values: Record<string, string | number | boolean | null>;
  onChange: (next: Record<string, string | number | boolean | null>) => void;
}) {
  if (fields.length === 0) return null;

  const set = (id: string, value: string | number | boolean | null) =>
    onChange({ ...values, [id]: value });

  return (
    <>
      {fields.map((field) => {
        const value = values[field.id];
        if (field.type === "checkbox") {
          return (
            <label
              key={field.id}
              className="flex items-center gap-2 self-end text-sm"
            >
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => set(field.id, e.target.checked)}
              />
              {field.label}
            </label>
          );
        }
        return (
          <Field key={field.id} label={field.label}>
            {field.type === "select" ? (
              <Select
                value={
                  value === null || value === undefined ? "" : String(value)
                }
                onChange={(e) => set(field.id, e.target.value || null)}
              >
                <option value="">—</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={
                  field.type === "number"
                    ? "number"
                    : field.type === "date"
                      ? "date"
                      : "text"
                }
                value={
                  value === null || value === undefined ? "" : String(value)
                }
                onChange={(e) =>
                  set(
                    field.id,
                    e.target.value === ""
                      ? null
                      : field.type === "number"
                        ? Number(e.target.value)
                        : e.target.value,
                  )
                }
              />
            )}
          </Field>
        );
      })}
    </>
  );
}

/** The same fields read back, for a record screen rather than a form. */
export function CustomValues({
  fields,
  values,
}: {
  fields: CustomField[];
  values: Record<string, string | number | boolean | null> | null | undefined;
}) {
  const filled = fields.filter((f) => {
    const value = values?.[f.id];
    return value !== undefined && value !== null && value !== "";
  });
  if (filled.length === 0) return null;

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {filled.map((field) => {
        const value = values?.[field.id];
        return (
          <div key={field.id}>
            <p className="text-xs" style={muted}>
              {field.label}
            </p>
            <p className="text-sm">
              {field.type === "checkbox"
                ? value === true
                  ? "Yes"
                  : "No"
                : field.type === "date"
                  ? formatDate(String(value))
                  : String(value)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Defining the fields a business keeps for itself.
 *
 * One editor for every module that has them. Which records they can be
 * attached to is the only thing that differs — the CRM has contacts, companies
 * and deals, and the accounting module has bills and money in and out — so
 * that is a parameter and everything else is shared. A second copy of this
 * would be a second place for a list field to lose its choices.
 */
export function CustomFieldEditor({
  fields,
  onChange,
  subjects,
  title = "Your own fields",
  hint,
}: {
  fields: CustomField[];
  onChange: (next: CustomField[]) => void;
  /** What a field can be attached to, in the order they should be offered. */
  subjects: { value: string; label: string }[];
  title?: string;
  hint?: string;
}) {
  const set = (index: number, patch: Partial<CustomField>) => {
    const next = [...fields];
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, ...patch };
    onChange(next);
  };

  return (
    <Card>
      <p className="font-medium">{title}</p>
      <p className="mb-3 text-sm" style={muted}>
        {hint ??
          "Anything this business needs to know that the product does not ship with. They appear on the form and on the record."}
      </p>

      {fields.length === 0 ? (
        <p className="mb-3 text-sm" style={muted}>
          None yet.
        </p>
      ) : (
        <ul className="mb-3 space-y-2">
          {fields.map((field, index) => (
            <li
              key={`${field.appliesTo}-${field.id}-${index}`}
              className="grid gap-2 sm:grid-cols-[1fr_8rem_8rem_auto]"
            >
              <Input
                value={field.label}
                aria-label="Field name"
                onChange={(e) => set(index, { label: e.target.value })}
              />
              <select
                value={field.type}
                aria-label="Kind of field"
                className="rounded border px-2 py-1.5 text-sm"
                style={{ ...border, background: "var(--surface-raised)" }}
                onChange={(e) =>
                  set(index, { type: e.target.value as CustomField["type"] })
                }
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="select">List</option>
                <option value="checkbox">Yes or no</option>
              </select>
              <select
                value={field.appliesTo}
                aria-label="Where it appears"
                className="rounded border px-2 py-1.5 text-sm"
                style={{ ...border, background: "var(--surface-raised)" }}
                onChange={(e) =>
                  set(index, {
                    appliesTo: e.target.value as CustomField["appliesTo"],
                  })
                }
              >
                {subjects.map((subject) => (
                  <option key={subject.value} value={subject.value}>
                    {subject.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="text-sm"
                style={{ color: "var(--color-danger)" }}
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
              >
                Remove
              </button>

              {field.type === "select" ? (
                <div className="sm:col-span-4">
                  <Input
                    value={(field.options ?? []).join(", ")}
                    aria-label={`Choices for ${field.label}`}
                    placeholder="Key safe, Tenant lets us in"
                    onChange={(e) =>
                      set(index, {
                        options: e.target.value
                          .split(",")
                          .map((o) => o.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        onClick={() =>
          onChange([
            ...fields,
            {
              id: "",
              label: "",
              type: "text",
              // The first one offered, so a new field is attached to something
              // rather than to an empty string the server will refuse.
              appliesTo: subjects[0]?.value ?? "",
            },
          ])
        }
      >
        Add a field
      </Button>
    </Card>
  );
}

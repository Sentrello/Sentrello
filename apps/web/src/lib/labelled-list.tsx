import { Input, muted } from "./ui";

/**
 * Editing "every way to reach somebody".
 *
 * A contact has one email that everything else in the system uses, and any
 * number of others that only a person cares about. That shape is awkward to
 * edit — a fixed pair of boxes cannot hold a third number, and a free-form list
 * loses the one that invoices are sent to.
 *
 * So the primary stays its own field elsewhere, and this edits the rest: a
 * label and a value, with a blank row always at the end. No add button,
 * because the row being there is the invitation, and an empty row is dropped
 * on save rather than stored as an empty contact method.
 */
export interface Labelled {
  label: string;
  value: string;
}

/** Drops the blanks. An empty row is somebody's cursor, not a phone number. */
export function tidy(rows: Labelled[]): Labelled[] {
  return rows
    .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
    .filter((r) => r.value !== "")
    .map((r) => ({ label: r.label || "other", value: r.value }));
}

/** What to show in the editor: the stored rows, plus one empty one to fill. */
export function withBlank(rows: Labelled[] | null | undefined): Labelled[] {
  return [...(rows ?? []), { label: "", value: "" }];
}

export function LabelledList({
  rows,
  onChange,
  placeholder,
}: {
  rows: Labelled[];
  onChange: (next: Labelled[]) => void;
  placeholder: string;
}) {
  const set = (i: number, patch: Partial<Labelled>) => {
    const next = rows.map((r, j) => (i === j ? { ...r, ...patch } : r));
    // Typing in the last row means another is wanted after it.
    const last = next[next.length - 1];
    if (last && (last.label || last.value)) next.push({ label: "", value: "" });
    onChange(next);
  };

  return (
    <div className="space-y-1">
      {rows.map((row, i) => (
        <div
          // Index as key: these rows have no identity of their own, and
          // anything derived from the value would remount the input the user
          // is typing into.
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id
          key={i}
          className="flex gap-1"
        >
          <Input
            value={row.label}
            placeholder="label"
            aria-label="Label"
            className="w-24"
            onChange={(e) => set(i, { label: e.target.value })}
          />
          <Input
            value={row.value}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => set(i, { value: e.target.value })}
          />
        </div>
      ))}
      <p className="text-xs" style={muted}>
        Leave a row blank to drop it.
      </p>
    </div>
  );
}

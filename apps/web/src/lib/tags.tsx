import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, may } from "./api";
import { Button, ErrorNote, Input, REFUSED, muted, textOn } from "./ui";

/**
 * The tag editor, for anything that can wear a tag.
 *
 * It was written on the contact page and then wanted on invoices and quotes.
 * Copying it would have been three places to fix the next thing about tags, so
 * it takes the path of whatever it is labelling instead: `/api/contacts/:id`,
 * `/api/invoices/:id`, `/api/quotes/:id`. The routes underneath already agree
 * on the shape — POST a `tagId`, DELETE by tag — because they were built
 * against the same `taggables` table.
 */

export interface TagChip {
  id: string;
  name: string;
  color: string;
}

/**
 * The colours a tag can be. One list, because there were two.
 *
 * Tags are scanned rather than read, so they need to differ at a glance — and
 * asking somebody to pick a hex code before they can label anything is a worse
 * first experience than choosing for them. So a tag made from a record gets
 * one of these at random, and the settings screen offers the same eight as
 * swatches.
 *
 * They were two disjoint lists with **not one colour in common**: this file
 * assigned from six Tailwind 500s, and the settings screen offered eight
 * lighter ones. So every tag ever created from a contact, a company or a deal
 * arrived in a colour that screen could not show as chosen — all eight
 * swatches computed `aria-pressed={false}`, nothing looked selected, and a
 * screen reader was told none of them was the current colour. Touching any
 * swatch then moved the tag into a palette nothing else assigns from.
 *
 * These eight are the settings screen's, not this file's, and deliberately:
 * `#94a3b8` is already what the server falls back to for a contact status
 * (`modules-free/crm/src/settings.ts`), so it is the list the rest of the
 * product had quietly agreed on.
 */
export const TAG_COLOURS = [
  "#94a3b8",
  "#f87171",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#38bdf8",
  "#a78bfa",
  "#f472b6",
];

export function randomTagColour(): string {
  return TAG_COLOURS[Math.floor(Math.random() * TAG_COLOURS.length)] as string;
}

export function TagChips({
  path,
  attached,
  onChanged,
}: {
  /** The document's own path, without `/tags`. */
  path: string;
  attached: TagChip[];
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [newName, setNewName] = useState("");

  const all = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: TagChip[] }>("/api/tags"),
    enabled: picking,
  });

  // Creating a tag where it is needed, rather than sending somebody to a
  // screen that manages them and back again.
  const create = useMutation({
    mutationFn: async () => {
      const made = await api<{ tag: { id: string } }>("/api/tags", {
        method: "POST",
        body: JSON.stringify({ name: newName, color: randomTagColour() }),
      });
      await api(`${path}/tags`, {
        method: "POST",
        body: JSON.stringify({ tagId: made.tag.id }),
      });
    },
    onSuccess: () => {
      setNewName("");
      setPicking(false);
      qc.invalidateQueries({ queryKey: ["tags"] });
      onChanged();
    },
  });

  const attach = useMutation({
    mutationFn: (tagId: string) =>
      api(`${path}/tags`, { method: "POST", body: JSON.stringify({ tagId }) }),
    onSuccess: () => {
      setPicking(false);
      onChanged();
    },
  });

  const detach = useMutation({
    mutationFn: (tagId: string) =>
      api(`${path}/tags/${tagId}`, { method: "DELETE" }),
    onSuccess: onChanged,
  });

  const on = new Set(attached.map((t) => t.id));
  const available = (all.data?.tags ?? []).filter((t) => !on.has(t.id));

  /*
   * Tagging a record writes to it, and the path is built from a holder —
   * `/api/${holder}/${id}/tags` — so it cannot be matched against the table
   * the server registers. It asks directly instead.
   *
   * One question for all three controls here: attaching a tag, taking one
   * off and opening the picker are the same permission, and a picker that
   * opens onto tags nobody may apply is a worse answer than one that does
   * not open.
   */
  const allowed = may("crm", "update");

  return (
    <div className="flex flex-wrap items-center gap-1">
      {attached.map((t) => (
        <button
          key={t.id}
          type="button"
          disabled={!allowed}
          onClick={() => detach.mutate(t.id)}
          title={allowed ? "Remove" : REFUSED}
          className="rounded-full px-2 py-0.5 text-xs"
          style={{ background: t.color, color: textOn(t.color) }}
        >
          {t.name} ×
        </button>
      ))}

      <button
        type="button"
        disabled={!allowed}
        title={allowed ? undefined : REFUSED}
        onClick={() => setPicking((v) => !v)}
        className="rounded-full border px-2 py-0.5 text-xs"
        style={{ borderColor: "var(--border)", ...muted }}
      >
        {picking ? "Cancel" : "+ Tag"}
      </button>

      {picking && available.length ? (
        <div className="flex flex-wrap gap-1">
          {available.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={!may("crm", "update")}
              onClick={() => attach.mutate(t.id)}
              className="rounded-full px-2 py-0.5 text-xs"
              // No opacity: it multiplies against the text as well as the chip, which
              // is how a measured colour arrives on screen failing.
              style={{ background: t.color, color: textOn(t.color) }}
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : null}

      {picking ? (
        <div className="flex items-center gap-1">
          <Input
            value={newName}
            placeholder="New tag"
            aria-label="New tag name"
            className="w-32"
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button
            needs={{ crm: ["create"] }}
            onClick={() => create.mutate()}
            disabled={!newName.trim() || create.isPending}
          >
            {create.isPending ? "…" : "Create"}
          </Button>
        </div>
      ) : null}
      {create.error || attach.error || detach.error ? (
        <ErrorNote error={create.error ?? attach.error ?? detach.error} />
      ) : null}
    </div>
  );
}

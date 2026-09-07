import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";
import { Button, ErrorNote, Input, muted } from "./ui";

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
 * Six colours, chosen for the user.
 *
 * Tags are scanned rather than read, so they need to differ at a glance — and
 * asking somebody to pick a hex code before they can label anything is a worse
 * first experience than choosing for them.
 */
const TAG_COLOURS = [
  "#22c55e",
  "#3b82f6",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#14b8a6",
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

  return (
    <div className="flex flex-wrap items-center gap-1">
      {attached.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => detach.mutate(t.id)}
          title="Remove"
          className="rounded-full px-2 py-0.5 text-xs"
          style={{ background: t.color, color: "#111" }}
        >
          {t.name} ×
        </button>
      ))}

      <button
        type="button"
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
              onClick={() => attach.mutate(t.id)}
              className="rounded-full px-2 py-0.5 text-xs"
              style={{ background: t.color, color: "#111", opacity: 0.75 }}
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
            onClick={() => create.mutate()}
            disabled={!newName.trim() || create.isPending}
          >
            {create.isPending ? "…" : "Create"}
          </Button>
        </div>
      ) : null}
      {create.error ? <ErrorNote error={create.error} /> : null}
    </div>
  );
}

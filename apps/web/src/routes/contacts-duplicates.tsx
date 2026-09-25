import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  Card,
  ConfirmButton,
  Empty,
  ErrorNote,
  Loading,
  SectionHeading,
  border,
  muted,
} from "../lib/ui";

/**
 * Likely duplicates, proposed — never merged on their own.
 *
 * Detection is cheap and wrong sometimes; merging is expensive and nearly
 * irreversible. So the screen shows why each pair looks like one person and
 * makes somebody choose which record survives, through a confirmation that
 * says exactly what will happen. "Not duplicates" is remembered, so a
 * father and son sharing a landline are not proposed again every visit.
 */

interface Duplicate {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string;
}

interface Pair {
  a: Duplicate;
  b: Duplicate;
  reason: string;
}

function describe(contact: Duplicate): string {
  return [contact.email, contact.phone].filter(Boolean).join(" · ");
}

export function ContactDuplicates({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const pairs = useQuery({
    queryKey: ["contacts/duplicates"],
    queryFn: () => api<{ pairs: Pair[] }>("/api/contacts/duplicates"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["contacts/duplicates"] });
    onChanged();
  };

  const merge = useMutation({
    mutationFn: ({ keep, fold }: { keep: Duplicate; fold: Duplicate }) =>
      api(`/api/contacts/${keep.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ mergedId: fold.id }),
      }),
    onSuccess: refresh,
  });

  const dismiss = useMutation({
    mutationFn: (pair: Pair) =>
      api("/api/contacts/duplicates/dismiss", {
        method: "POST",
        body: JSON.stringify({ aId: pair.a.id, bId: pair.b.id }),
      }),
    onSuccess: refresh,
  });

  if (pairs.isLoading) return <Loading />;

  const found = pairs.data?.pairs ?? [];
  if (found.length === 0) {
    return (
      <Empty title="No likely duplicates">
        Contacts sharing an email address, phone number or full name would be
        proposed here.
      </Empty>
    );
  }

  return (
    <Card>
      <SectionHeading>Likely duplicates</SectionHeading>
      <p className="mb-3 text-sm" style={muted}>
        Nothing is merged until you choose which record to keep. Everything on
        the other one — notes, tasks, deals, quotes and invoices — follows the
        record you keep.
      </p>
      <ul className="flex flex-col gap-(--gap-toolbar)">
        {found.map((pair) => (
          <li
            key={`${pair.a.id}-${pair.b.id}`}
            className="flex flex-wrap items-center gap-3 rounded border px-3 py-2"
            style={border}
          >
            <span className="min-w-0 flex-1 text-sm">
              <span className="block font-medium">
                {pair.a.name ?? "Unnamed"} · {pair.b.name ?? "Unnamed"}
              </span>
              <span className="block text-xs" style={muted}>
                {pair.reason}
                {describe(pair.a) ? ` — ${describe(pair.a)}` : ""}
              </span>
            </span>
            {(
              [
                [pair.a, pair.b],
                [pair.b, pair.a],
              ] as const
            ).map(([keep, fold]) => (
              <ConfirmButton
                key={keep.id}
                title="Merge these contacts?"
                message={`"${fold.name ?? "the other record"}" will be folded into "${keep.name ?? "this record"}" and deleted. Its notes, tasks, deals, quotes and invoices will follow the kept record. This cannot be undone from a screen.`}
                confirmLabel={`Merge into ${keep.name ?? "kept record"}`}
                variant="secondary"
                disabled={merge.isPending}
                onConfirm={() => merge.mutate({ keep, fold })}
              >
                Keep {keep.name ?? keep.id.slice(0, 8)}
              </ConfirmButton>
            ))}
            <button
              type="button"
              className="text-xs link-muted"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(pair)}
            >
              Not duplicates
            </button>
          </li>
        ))}
      </ul>
      {/*
        A merge that failed is the one nobody can see going wrong: the pair
        stays on the list either way, so without this the button reads as a
        click that did not register and gets pressed again.
      */}
      {merge.error ? <ErrorNote error={merge.error} /> : null}
      {dismiss.error ? <ErrorNote error={dismiss.error} /> : null}
    </Card>
  );
}

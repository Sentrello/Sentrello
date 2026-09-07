import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Company, type Tag, api } from "../lib/api";
import { useSession } from "../lib/auth";
import { Avatar } from "../lib/avatar";
import {
  managerName,
  useCrmManagers,
  useCrmSettings,
} from "../lib/crm-settings";
import { Icon } from "../lib/icons";
import { listQueryString, useListState } from "../lib/list-ui";
import { RelatedLink, useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Select,
  border,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The pipeline, as a board.
 *
 * Each column carries its total, because the question a business asks a
 * pipeline is "how much is in play", not "how many cards are there". A board
 * that only counts cards makes a £2,000 job look like a £20,000 one.
 */

interface Deal {
  id: string;
  name: string;
  stage: string;
  amountCents: number;
  category: string | null;
  expectedCloseOn: string | null;
  position: number;
  companyId: string | null;
  archivedAt: string | null;
}

/** Left to right, in the order a deal actually travels. */
/**
 * What the board draws before the server has answered.
 *
 * These used to *be* the pipeline, hard-coded here, which meant every business
 * ran the process a developer picked. They are now only the fallback: CRM
 * Settings owns the real list, and an instance that has never opened it gets
 * exactly these.
 */
const DEFAULT_STAGES = [
  { id: "opportunity", label: "Opportunity" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

interface Stage {
  id: string;
  label: string;
}

/**
 * Moving a card without dragging it.
 *
 * Drag and drop is the natural gesture and it is not available to everybody —
 * a keyboard, a screen reader and a touch screen all need somewhere else to
 * go. Three dots is the smallest thing that provides it.
 */
function StageMenu({
  deal,
  stages,
  onMove,
}: {
  deal: Deal;
  stages: Stage[];
  onMove: (id: string, stage: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        className="link-muted rounded px-1"
        aria-label={`Move ${deal.name} to another stage`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      {open ? (
        // Closing on blur rather than a document listener: the panel holds
        // the only things worth clicking, so losing focus is the same event.
        <div className="menu-panel z-10" onMouseLeave={() => setOpen(false)}>
          {stages
            .filter((s) => s.id !== deal.stage)
            .map((s) => (
              <button
                key={s.id}
                type="button"
                className="menu-item"
                onClick={() => {
                  onMove(deal.id, s.id);
                  setOpen(false);
                }}
              >
                Move to {s.label}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function Column({
  stages,
  stage,
  label,
  deals,
  companyName,
  onMove,
}: {
  /** Every stage, so a card can be moved to any of them without a mouse. */
  stages: Stage[];
  stage: string;
  label: string;
  deals: Deal[];
  companyName: (id: string | null) => string | undefined;
  onMove: (id: string, stage: string) => void;
}) {
  const { open } = useNavigation();
  const total = deals.reduce((sum, d) => sum + d.amountCents, 0);

  return (
    <div
      className="flex w-64 shrink-0 flex-col rounded-lg border p-2"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      // Dropping is how a card changes column. Keyboard users get the select
      // on each card instead, so the board is not mouse-only.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        if (id) onMove(id, stage);
      }}
    >
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs" style={muted}>
          {deals.length} · {formatMoney(total)}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {deals.map((d) => (
          <div
            key={d.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", d.id)}
            className="rounded border p-2"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface-raised)",
            }}
          >
            <div className="flex items-start gap-2">
              {/*
                Whose deal it is, at a glance. A column of names alone tells
                you what is in play but not who with, which is the first thing
                anybody looking at a pipeline wants to know.
              */}
              {d.companyId ? (
                <Avatar
                  src={`/api/crm/companies/${d.companyId}/image`}
                  // The company's initials, not the deal's: the mark is there
                  // to say who the job is for, and "RR" for "Roof
                  // replacement" says nothing at all.
                  name={companyName(d.companyId) ?? d.name}
                  size={24}
                  rounded="md"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <RelatedLink
                  to={{ moduleId: "deals", recordId: d.id, title: d.name }}
                >
                  {d.name}
                </RelatedLink>
                <div className="mt-0.5 text-xs" style={muted}>
                  {formatMoney(d.amountCents)}
                  {d.category ? ` · ${d.category}` : ""}
                </div>
              </div>

              {/*
                The same move, reachable without a mouse.

                A menu rather than the select that used to sit across the
                bottom of every card: a deal is a thing you drag, and a
                permanent dropdown on each one made the board look like a
                form. Behind a button it stays out of the way and the board
                stays operable from the keyboard, which dragging alone is not.
              */}
              <StageMenu deal={d} stages={stages} onMove={onMove} />
            </div>
          </div>
        ))}
        {deals.length === 0 ? (
          <p className="px-1 py-2 text-xs" style={muted}>
            Nothing here.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function Deals() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");

  /**
   * A board is never paged: every column has to show everything in it, or the
   * totals across the top are lies. So the query goes out unpaged, and the
   * narrowing is done by the search and the filters instead.
   */
  const state = useListState({ sort: "position", order: "asc" });
  const query = listQueryString(state, false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["deals", query],
    queryFn: () => api<{ deals: Deal[] }>(`/api/deals?${query}`),
    placeholderData: (previous) => previous,
  });

  /**
   * The pipeline this business actually runs, from CRM Settings.
   *
   * Falls back to the defaults rather than an empty board while it loads, and
   * on an instance that has never configured them.
   */
  const settings = useCrmSettings();
  const stages = settings.dealStages.length
    ? settings.dealStages
    : DEFAULT_STAGES;

  const session = useSession();
  const myId = session.data?.user?.id;
  const managers = useCrmManagers();

  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: Tag[] }>("/api/tags"),
  });

  const companies = useQuery({
    queryKey: ["companies", "all"],
    queryFn: () => api<{ companies: Company[] }>("/api/companies"),
  });
  const companyName = (id: string | null) =>
    id ? companies.data?.companies.find((c) => c.id === id)?.name : undefined;

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) =>
      api(`/api/deals/${id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ stage }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deals"] }),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/api/deals", {
        method: "POST",
        body: JSON.stringify({
          name,
          // Typed in pounds or dollars; stored as integer cents, like all money
          // in this system.
          amountCents: Math.round(Number(amount || 0) * 100),
          stage: "opportunity",
        }),
      }),
    onSuccess: () => {
      setName("");
      setAmount("");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["deals"] });
    },
  });

  if (error) return <ErrorNote error={error} />;

  // Archived deals are already excluded by the server unless asked for.
  const deals = data?.deals ?? [];
  const byStage = (stage: string) =>
    deals
      .filter((d) => d.stage === stage)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  const openTotal = deals
    .filter((d) => d.stage !== "won" && d.stage !== "lost")
    .reduce((sum, d) => sum + d.amountCents, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2"
            style={muted}
          >
            <Icon name="search" size={15} />
          </span>
          {/* Matches the deal's own name, its company, and anybody attached
              to it — which is how people actually refer to a job. */}
          <input
            value={state.q}
            onChange={(e) => state.setQ(e.target.value)}
            placeholder="Search deals, companies, contacts"
            aria-label="Search deals"
            className="w-72 rounded-md border py-1.5 pr-2 pl-7 text-sm"
            style={{ ...border, background: "var(--surface-raised)" }}
          />
        </div>

        {settings.dealCategories.length ? (
          <Select
            value={state.filters.category ?? ""}
            aria-label="Filter by category"
            className="w-auto"
            onChange={(e) =>
              state.setFilter({ category: e.target.value || undefined })
            }
          >
            <option value="">Every category</option>
            {settings.dealCategories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </Select>
        ) : null}

        {tags.data?.tags.length ? (
          <Select
            value={state.filters.tagId ?? ""}
            aria-label="Filter by tag"
            className="w-auto"
            onChange={(e) =>
              state.setFilter({ tagId: e.target.value || undefined })
            }
          >
            <option value="">Every tag</option>
            {tags.data.tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </Select>
        ) : null}

        {/*
          Whose deals to show. "Mine" is the common case and stays first; the
          rest of the list is everybody the platform says can own a record,
          rather than a list this module keeps for itself.
        */}
        <Select
          value={state.filters.ownerId ?? ""}
          aria-label="Account manager"
          className="w-auto"
          onChange={(e) =>
            state.setFilter({ ownerId: e.target.value || undefined })
          }
        >
          <option value="">Everybody's deals</option>
          {myId ? <option value={myId}>Companies I manage</option> : null}
          {managers
            .filter((manager) => manager.userId !== myId)
            .map((manager) => (
              <option key={manager.userId} value={manager.userId}>
                {managerName(manager)}
              </option>
            ))}
        </Select>

        {state.hasFilters || state.q ? (
          <button
            type="button"
            className="text-xs link-muted"
            onClick={() => {
              state.clearFilters();
              state.setQ("");
            }}
          >
            Clear
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {/* The filters travel with it, so the file is the board somebody is
              looking at rather than the whole pipeline. */}
          <a
            href={`/api/deals/export.csv?${listQueryString(state, false)}`}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
            style={border}
          >
            <Icon name="file-text" size={15} />
            Export
          </a>
          <Button onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "New deal"}
          </Button>
        </div>
      </div>

      <p className="text-sm" style={muted}>
        {formatMoney(openTotal)} in play across {deals.length}{" "}
        {deals.length === 1 ? "deal" : "deals"}
      </p>

      {adding ? (
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Amount" hint="What the job is worth.">
              <Input
                value={amount}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Button
              onClick={() => create.mutate()}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          {create.error ? <ErrorNote error={create.error} /> : null}
        </Card>
      ) : null}

      {move.error ? <ErrorNote error={move.error} /> : null}

      {isLoading ? <Loading /> : null}

      {/* Scrolls sideways rather than squeezing five columns onto a phone. */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((s) => (
          <Column
            key={s.id}
            stages={stages}
            stage={s.id}
            label={s.label}
            deals={byStage(s.id)}
            companyName={companyName}
            onMove={(id, stage) => move.mutate({ id, stage })}
          />
        ))}
      </div>
    </div>
  );
}

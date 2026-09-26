import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Tag, api } from "../lib/api";
import { useSession } from "../lib/auth";
import { Avatar } from "../lib/avatar";
import {
  managerName,
  useCrmManagers,
  useCrmSettings,
} from "../lib/crm-settings";
import { Icon } from "../lib/icons";
import {
  ComputedCells,
  type ComputedColumn,
  listQueryString,
  useListState,
} from "../lib/list-ui";
import { RelatedLink, useNavigation } from "../lib/navigation";
import { SavedViews } from "../lib/saved-views";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  PageActions,
  RowMenu,
  Select,
  Toolbar,
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
  /**
   * Whose job it is, resolved for the page by the list route.
   *
   * The board used to build its own lookup by fetching every company, which
   * is capped at a thousand rows — so at a larger business a card lost the
   * customer's name and, with it, the initials on its avatar.
   */
  companyName: string | null;
  archivedAt: string | null;
  /** Worked out on read by whatever module defines computed columns. */
  computed?: Record<string, { value: number | string | null; reason?: string }>;
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
/**
 * Moving a deal, from the card it is on.
 *
 * This was a hand-rolled panel and it had all three faults `RowMenu` exists to
 * solve, which is what a hand-rolled panel gets you.
 *
 * It was absolutely positioned inside a `<section className="… overflow-x-auto">`,
 * so a card near the right edge of a column had its menu clipped by the
 * scroller — the board is horizontal, so that is most of them on a narrow
 * window. `RowMenu` measures the trigger and draws into a portal on the body,
 * which no ancestor can cut.
 *
 * And it closed on `onMouseLeave` and nothing else. No Escape, no click
 * outside, no close on blur. Open it with a keyboard and there was no way to
 * shut it with one; open it on a touchscreen, where there is no such thing as
 * leaving with the pointer, and it stayed open until something else was
 * pressed.
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
  return (
    <div className="shrink-0">
      <RowMenu label={`Move ${deal.name} to another stage`}>
        {(close) =>
          stages
            .filter((s) => s.id !== deal.stage)
            .map((s) => (
              <button
                key={s.id}
                type="button"
                className="menu-item"
                onClick={() => {
                  onMove(deal.id, s.id);
                  close();
                }}
              >
                Move to {s.label}
              </button>
            ))
        }
      </RowMenu>
    </div>
  );
}

function Column({
  stages,
  stage,
  label,
  deals,
  columns,
  onMove,
}: {
  /** Every stage, so a card can be moved to any of them without a mouse. */
  stages: Stage[];
  stage: string;
  label: string;
  deals: Deal[];
  /** Columns a module works out, when this instance has one that does. */
  columns: ComputedColumn[] | undefined;
  onMove: (id: string, stage: string) => void;
}) {
  const { open } = useNavigation();
  const total = deals.reduce((sum, d) => sum + d.amountCents, 0);

  return (
    <div
      className="flex w-64 shrink-0 flex-col rounded-lg border border-line p-2"
      style={{ background: "var(--surface)" }}
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

      <div className="flex flex-col gap-(--gap-toolbar)">
        {deals.map((d) => (
          <div
            key={d.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", d.id)}
            className="rounded border border-line p-2"
            style={{ background: "var(--surface-raised)" }}
          >
            <div className="flex items-start gap-(--gap-toolbar)">
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
                  name={d.companyName ?? d.name}
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
                <div
                  className="mt-0.5 flex flex-wrap gap-x-(--gap-toolbar) text-xs"
                  style={muted}
                >
                  <span>
                    {formatMoney(d.amountCents)}
                    {d.category ? ` · ${d.category}` : ""}
                  </span>
                  <ComputedCells columns={columns} row={d} />
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
   *
   * Unpaged is still capped — a thousand rows, said in `truncated` — and that
   * is the one case where the paragraph above stops being true. So the flag
   * is read and the board says the totals are of what it can see, instead of
   * printing a figure that is confidently short. Narrowing the filters is the
   * answer, and it is the answer the board already has.
   */
  const state = useListState({ sort: "position", order: "asc" });
  const query = listQueryString(state, false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["deals", query],
    queryFn: () =>
      api<{
        deals: Deal[];
        computedColumns?: ComputedColumn[];
        truncated?: boolean;
      }>(`/api/deals?${query}`),
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

  // No error branch on purpose: all this feeds is the tag filter, which just
  // disappears. A dropdown with nothing in it claims nothing about the deals,
  // and a note beside every lookup on a board is how notes get ignored.
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: Tag[] }>("/api/tags"),
  });

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
    <Page>
      <PageActions>
        <Button
          needs={{ crm: ["create"] }}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "Cancel" : "New deal"}
        </Button>
      </PageActions>

      <Toolbar>
        {/* Matches the deal's own name, its company, and anybody attached
            to it — which is how people actually refer to a job. */}
        <Input
          value={state.q}
          onChange={(e) => state.setQ(e.target.value)}
          placeholder="Search deals, companies, contacts"
          aria-label="Search deals"
          className="w-72"
        />

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

        {/* "Worth at least" — the other half of "my open deals over five
            thousand". Typed in whole currency, sent as integer cents. */}
        <span className="flex items-center gap-1.5 text-sm" style={muted}>
          Worth at least
          <Input
            value={
              state.filters.minAmountCents
                ? String(Number(state.filters.minAmountCents) / 100)
                : ""
            }
            inputMode="numeric"
            aria-label="Minimum amount"
            className="w-24"
            onChange={(e) => {
              const whole = Number(e.target.value);
              state.setFilter({
                minAmountCents:
                  e.target.value.trim() && Number.isFinite(whole)
                    ? String(Math.round(whole * 100))
                    : undefined,
              });
            }}
          />
        </span>

        <SavedViews
          resource="deals"
          state={state}
          defaults={{ sort: "position", order: "asc" }}
        />

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

        <div className="ml-auto flex flex-wrap items-center gap-(--gap-toolbar)">
          {/* The filters travel with it, so the file is the board somebody is
              looking at rather than the whole pipeline. */}
          <a
            href={`/api/deals/export.csv?${listQueryString(state, false)}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm"
          >
            Export
          </a>
        </div>
      </Toolbar>

      <p className="text-sm" style={muted}>
        {formatMoney(openTotal)} in play across {deals.length}{" "}
        {deals.length === 1 ? "deal" : "deals"}
        {data?.truncated
          ? " — the first 1,000 only. Search or filter to see the rest; the totals above count what is shown."
          : ""}
      </p>

      {adding ? (
        <Card>
          <div className="grid gap-(--gap-toolbar) sm:grid-cols-2">
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
          <Toolbar className="mt-(--gap-stack)">
            <Button
              needs={{ crm: ["create"] }}
              onClick={() => create.mutate()}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </Toolbar>
          {create.error ? <ErrorNote error={create.error} /> : null}
        </Card>
      ) : null}

      {move.error ? <ErrorNote error={move.error} /> : null}

      {isLoading ? <Loading /> : null}

      {/* Scrolls sideways rather than squeezing five columns onto a phone. */}
      {/*
        Reachable by keyboard, because it scrolls.
        A board wider than the window is content somebody using arrow keys
        cannot reach at all unless the container can take focus — the columns
        past the fold might as well not exist for them.
      */}
      <section
        className="flex gap-(--gap-toolbar) overflow-x-auto pb-2"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1 requires a scrollable region to be keyboard-operable and tabindex=0 on the scroll container is the documented remedy; the rule does not model scrolling containers
        tabIndex={0}
        aria-label="Deal stages"
      >
        {stages.map((s) => (
          <Column
            key={s.id}
            stages={stages}
            stage={s.id}
            label={s.label}
            deals={byStage(s.id)}
            columns={data?.computedColumns}
            onMove={(id, stage) => move.mutate({ id, stage })}
          />
        ))}
      </section>
    </Page>
  );
}

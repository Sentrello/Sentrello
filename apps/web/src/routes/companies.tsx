import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { COMPANY_SIZES, type Company, api } from "../lib/api";
import { useSession } from "../lib/auth";
import { Avatar } from "../lib/avatar";
import {
  managerName,
  useCrmManagers,
  useCrmSettings,
} from "../lib/crm-settings";
import { CustomValues } from "../lib/custom-fields";
import { Icon } from "../lib/icons";
import { ImageUpload } from "../lib/image-upload";
import {
  FilterGroup,
  FilterPanel,
  FilterToggle,
  Pagination,
  SortMenu,
  useListQuery,
  useListState,
} from "../lib/list-ui";
import { RelatedLink, useNavigation, useRecordTitle } from "../lib/navigation";
import { type Task, TaskList } from "../lib/tasks";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Table,
  border,
  formatMoney,
  muted,
} from "../lib/ui";
import { CompanyForm } from "./company-form";
import { HistoryPanel } from "./contact-detail";

interface Related {
  company: Company;
  contacts: { id: string; name: string; title: string | null }[];
  deals: { id: string; name: string; stage: string; amountCents: number }[];
  notes: { id: string; text: string; createdAt: string }[];
  tasks: Task[];
}

const CLOSED = new Set(["won", "lost"]);

/**
 * The companies the business sells to, as cards.
 *
 * Atomic shows a grid rather than a table, and it is right to: what somebody
 * wants from this screen is "who are we working with", answered by a logo, a
 * sector, the faces of the people there and how many deals are open. A table
 * of the same information is five columns of text nobody reads.
 */
export function Companies() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [adding, setAdding] = useState(false);

  const state = useListState({ sort: "name", order: "asc" });
  const settings = useCrmSettings();
  const managers = useCrmManagers();
  const session = useSession();
  const myId = session.data?.user?.id;

  const { rows, total, paginated, isLoading, error } = useListQuery<Company>(
    "companies",
    state,
  );

  if (error) return <ErrorNote error={error} />;

  return (
    <div className="flex gap-6">
      <FilterPanel state={state} placeholder="Search companies">
        <FilterGroup label="Size" icon="users">
          {COMPANY_SIZES.map((size) => (
            <FilterToggle
              key={size.id}
              label={size.label}
              active={state.isFilterActive({ size: String(size.id) })}
              onClick={() => state.toggleFilter({ size: String(size.id) })}
            />
          ))}
        </FilterGroup>

        {settings.companySectors.length ? (
          <FilterGroup label="Sector" icon="briefcase">
            {settings.companySectors.map((sector) => (
              <FilterToggle
                key={sector}
                label={sector}
                active={state.isFilterActive({ sector })}
                onClick={() => state.toggleFilter({ sector })}
              />
            ))}
          </FilterGroup>
        ) : null}

        <FilterGroup label="Account manager" icon="user">
          <FilterToggle
            label="Companies I manage"
            active={!!myId && state.isFilterActive({ ownerId: myId })}
            onClick={() => myId && state.toggleFilter({ ownerId: myId })}
          />
          {managers
            .filter((manager) => manager.userId !== myId)
            .map((manager) => (
              <FilterToggle
                key={manager.userId}
                label={managerName(manager)}
                active={state.isFilterActive({ ownerId: manager.userId })}
                onClick={() => state.toggleFilter({ ownerId: manager.userId })}
              />
            ))}
        </FilterGroup>
      </FilterPanel>

      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SortMenu
            state={state}
            fields={[
              { field: "name", label: "Name", order: "asc" },
              { field: "createdAt", label: "Date added", order: "desc" },
              { field: "sector", label: "Sector", order: "asc" },
              { field: "size", label: "Size", order: "desc" },
              { field: "city", label: "City", order: "asc" },
            ]}
          />

          <div className="ml-auto flex items-center gap-2">
            {/* A plain link, not a fetch: the browser downloads it with the
                filename the server sends, and the session cookie goes along.
                The filters travel with it, so the file matches the screen. */}
            <a
              href={`/api/companies/export.csv?${new URLSearchParams(state.filters).toString()}`}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
              style={border}
            >
              <Icon name="file-text" size={15} />
              Export
            </a>
            <Button onClick={() => setAdding(true)}>
              <span className="flex items-center gap-1.5">
                <Icon name="plus" size={15} />
                New company
              </span>
            </Button>
          </div>
        </div>

        {adding ? (
          <CompanyForm
            settings={settings}
            onDone={(saved) => {
              setAdding(false);
              qc.invalidateQueries({ queryKey: ["companies"] });
              if (saved) {
                open({
                  moduleId: "companies",
                  recordId: saved.id,
                  title: saved.name,
                });
              }
            }}
          />
        ) : null}

        {isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            title={
              state.q || state.hasFilters ? "No matches" : "No companies yet"
            }
          >
            {state.q || state.hasFilters
              ? "Try a different search, or clear the filters."
              : "A company groups the people who work there and the deals in flight."}
          </Empty>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {rows.map((co) => (
                <CompanyCard
                  key={co.id}
                  company={co}
                  onOpen={() =>
                    open({
                      moduleId: "companies",
                      recordId: co.id,
                      title: co.name,
                    })
                  }
                />
              ))}
            </div>

            {paginated ? <Pagination state={state} total={total} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One company, at a glance.
 *
 * The logo, the name and the sector at the top; who works there and what is
 * in play at the bottom. The faces are the part that makes the grid worth
 * having — a company with four people attached reads as a real relationship,
 * and one with none reads as a name somebody typed in once.
 */
function CompanyCard({
  company,
  onOpen,
}: {
  company: Company;
  onOpen: () => void;
}) {
  const staff = company.contacts ?? [];
  const extra = (company.contactCount ?? 0) - staff.length;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-44 flex-col justify-between rounded border p-4 text-center"
      style={{ ...border, background: "var(--surface-raised)" }}
    >
      <span className="flex flex-col items-center gap-1">
        <Avatar
          src={
            company.logoPath ? `/api/crm/companies/${company.id}/image` : null
          }
          name={company.name}
          size={44}
          rounded="md"
        />
        <span className="link mt-1 block font-medium">{company.name}</span>
        <span className="block text-xs" style={muted}>
          {company.sector ?? "\u00a0"}
        </span>
      </span>

      <span className="flex w-full items-center justify-between gap-2">
        <span className="flex items-center -space-x-1.5">
          {staff.map((person) => (
            <Avatar
              key={person.id}
              src={
                person.avatarPath
                  ? `/api/crm/contacts/${person.id}/image`
                  : null
              }
              name={person.name}
              size={24}
            />
          ))}
          {extra > 0 ? (
            <span className="pl-2.5 text-xs" style={muted}>
              +{extra}
            </span>
          ) : null}
        </span>

        {company.dealCount ? (
          <span className="flex items-center gap-1 text-xs" style={muted}>
            <Icon name="handshake" size={14} />
            <span className="font-medium">{company.dealCount}</span>
            {company.dealCount === 1 ? "deal" : "deals"}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function CompanyDetail() {
  const qc = useQueryClient();
  const { current } = useNavigation();
  const settings = useCrmSettings();
  const id = current.recordId;
  const [editing, setEditing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["company-related", id],
    queryFn: () => api<Related>(`/api/companies/${id}/related`),
    enabled: Boolean(id),
  });

  // A link somebody was sent shows the company, not "Companies".
  useRecordTitle(data?.company.name);

  if (!id) return <Empty title="No company selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { company, contacts, deals, tasks } = data;
  const open = deals.filter((d) => !CLOSED.has(d.stage));
  const inFlight = open.reduce((sum, d) => sum + d.amountCents, 0);

  if (editing) {
    // The same form as creating one. Two forms over the same record is how
    // a field ends up editable in one place and not the other.
    return (
      <CompanyForm
        company={company}
        settings={settings}
        onDone={() => {
          setEditing(false);
          qc.invalidateQueries({ queryKey: ["company-related", id] });
          qc.invalidateQueries({ queryKey: ["companies"] });
        }}
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-center gap-3">
              <ImageUpload
                subject="companies"
                id={company.id}
                name={company.name}
                hasImage={Boolean(company.logoPath)}
                rounded="md"
              />
              <p className="text-lg font-semibold">{company.name}</p>
            </div>
            <button
              type="button"
              className="text-sm link-muted"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </div>
          <p className="text-sm" style={muted}>
            {[
              company.sector,
              company.size ? `${company.size} people` : null,
              [company.city, company.country].filter(Boolean).join(", ") ||
                null,
            ]
              .filter(Boolean)
              .join(" · ") || "No details recorded"}
          </p>

          {company.description ? (
            <p className="mt-3 text-sm">{company.description}</p>
          ) : null}

          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {company.phone ? (
              <p>
                <span style={muted}>Phone: </span>
                <a href={`tel:${company.phone}`} className="link">
                  {company.phone}
                </a>
              </p>
            ) : null}
            {company.website ? (
              <p>
                <span style={muted}>Web: </span>
                <a
                  href={company.website}
                  target="_blank"
                  rel="noreferrer"
                  className="link"
                >
                  {company.website}
                </a>
              </p>
            ) : null}
            {company.address ? (
              <p className="whitespace-pre-wrap sm:col-span-2">
                <span style={muted}>Address: </span>
                {company.address}
              </p>
            ) : null}
          </div>
        </Card>

        <Card>
          <p className="mb-2 font-medium">People here</p>
          {contacts.length === 0 ? (
            <p className="text-sm" style={muted}>
              Nobody recorded at this company yet.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {contacts.map((p) => (
                <li key={p.id}>
                  <RelatedLink
                    to={{ moduleId: "contacts", recordId: p.id, title: p.name }}
                  >
                    {p.name}
                  </RelatedLink>
                  {p.title ? (
                    <span className="ml-1 text-xs" style={muted}>
                      {p.title}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <p className="mb-1 font-medium">Deals</p>
        {/* The number a business actually wants off this screen: what is on the
            table with this customer right now. */}
        <p className="mb-2 text-sm" style={muted}>
          {open.length} open · {formatMoney(inFlight)} in flight
        </p>
        {deals.length === 0 ? (
          <p className="text-sm" style={muted}>
            Nothing in the pipeline.
          </p>
        ) : (
          <div className="space-y-2">
            {deals.map((d) => (
              <div key={d.id} className="text-sm">
                <RelatedLink
                  to={{ moduleId: "deals", recordId: d.id, title: d.name }}
                >
                  {d.name}
                </RelatedLink>
                <div className="text-xs" style={muted}>
                  {d.stage} · {formatMoney(d.amountCents)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/*
        The account's own tasks — "renew the retainer", "chase the PO" — which
        belong to the company rather than to whoever happened to answer the
        phone. The same row and the same four actions as the contact page and
        the CRM dashboard.
      */}
      <Card>
        <TaskList
          tasks={tasks}
          taskTypes={settings.taskTypes}
          subject={{ companyId: company.id }}
          invalidate={[["company-related", id], ["crm-dashboard"]]}
          emptyText="Nothing outstanding for this company."
        />
      </Card>

      <CustomValues
        fields={settings.customFields.filter((f) => f.appliesTo === "company")}
        values={company.customValues}
      />

      {/* Nothing hangs off a company directly, so this is its people's
          history gathered into one column. */}
      <HistoryPanel companyId={company.id} />
    </div>
  );
}

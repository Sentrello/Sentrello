import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Meta, api } from "../lib/api";
import type { CustomField } from "../lib/crm-settings";
import { CustomFieldEditor } from "../lib/custom-fields";

/** What a CRM field can be attached to, in the order they are offered. */
const CRM_SUBJECTS = [
  { value: "contact", label: "Contacts" },
  { value: "company", label: "Companies" },
  { value: "deal", label: "Deals" },
];
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  border,
  muted,
} from "../lib/ui";

/**
 * The CRM's own settings: the pipeline, and the labels the business uses.
 *
 * The deal stages were a five-item constant in this file's neighbour, which
 * meant every business ran a process somebody else picked. A roofer's pipeline
 * is quote → measured → scheduled; a consultancy's is nothing like it.
 */

interface Settings {
  dealStages: { id: string; label: string }[];
  taskTypes: string[];
  contactStatuses: { id: string; label: string; color: string }[];
  dealCategories: string[];
  companySectors: string[];
  /** Which stages mean the deal came off, and which mean it did not. */
  wonStages: string[];
  lostStages: string[];
  /** The fields this business added for itself. */
  customFields: CustomField[];
  usingDefaults: boolean;
}

interface Tag {
  id: string;
  name: string;
  color: string;
}

/** Muted enough to read against, distinct enough to scan by. */
const TAG_COLOURS = [
  "#94a3b8",
  "#f87171",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#38bdf8",
  "#a78bfa",
  "#f472b6",
];

export function CrmSettings() {
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: ["crm-settings"],
    queryFn: () => api<Settings>("/api/crm/settings"),
  });
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: Tag[] }>("/api/tags"),
  });

  /**
   * Held locally while being edited, saved on a press.
   *
   * A pipeline is rearranged in several moves — rename one, add another, drag
   * a third — and saving each keystroke would mean a half-renamed stage
   * reaching the board somebody else is looking at.
   */
  const [stages, setStages] = useState<Settings["dealStages"] | null>(null);
  const [types, setTypes] = useState<string[] | null>(null);
  const [statuses, setStatuses] = useState<Settings["contactStatuses"] | null>(
    null,
  );
  const [categories, setCategories] = useState<string[] | null>(null);
  const [sectors, setSectors] = useState<string[] | null>(null);
  const [won, setWon] = useState<string[] | null>(null);
  const [lost, setLost] = useState<string[] | null>(null);
  const [fields, setFields] = useState<CustomField[] | null>(null);

  // Already in the cache from the shell's own fetch, so this costs no request.
  const tier = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/api/_meta"),
  }).data?.tier;
  const [newTag, setNewTag] = useState("");

  const save = useMutation({
    mutationFn: (body: Omit<Settings, "usingDefaults">) =>
      api<Settings>("/api/crm/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (saved) => {
      setStages(null);
      setTypes(null);
      setStatuses(null);
      setCategories(null);
      setSectors(null);
      setWon(null);
      setLost(null);
      setFields(null);
      qc.setQueryData(["crm-settings"], saved);
      // The board, the lists and the filters all draw themselves from these.
      qc.invalidateQueries({ queryKey: ["deals"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
  });

  const addTag = useMutation({
    mutationFn: (name: string) =>
      api("/api/tags", {
        method: "POST",
        body: JSON.stringify({
          name,
          color:
            TAG_COLOURS[(tags.data?.tags.length ?? 0) % TAG_COLOURS.length],
        }),
      }),
    onSuccess: () => {
      setNewTag("");
      qc.invalidateQueries({ queryKey: ["tags"] });
    },
  });

  const recolour = useMutation({
    mutationFn: ({ id, color }: { id: string; color: string }) =>
      api(`/api/tags/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ color }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
  });

  const removeTag = useMutation({
    mutationFn: (id: string) =>
      api<{ removedFrom: number }>(`/api/crm/tags/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
  });

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  if (!settings.data) return null;

  const current = stages ?? settings.data.dealStages;
  const currentTypes = types ?? settings.data.taskTypes;
  const currentStatuses = statuses ?? settings.data.contactStatuses;
  const currentCategories = categories ?? settings.data.dealCategories;
  const currentSectors = sectors ?? settings.data.companySectors;
  const currentWon = won ?? settings.data.wonStages;
  const currentLost = lost ?? settings.data.lostStages;
  const dirty =
    stages !== null ||
    types !== null ||
    statuses !== null ||
    categories !== null ||
    sectors !== null ||
    won !== null ||
    lost !== null ||
    fields !== null;

  /** Everything the screen is holding, as the server wants it. */
  const pending = {
    dealStages: current,
    taskTypes: currentTypes,
    contactStatuses: currentStatuses,
    dealCategories: currentCategories,
    companySectors: currentSectors,
    // A stage that has been renamed away cannot still be an outcome.
    wonStages: currentWon.filter((id) => current.some((s) => s.id === id)),
    lostStages: currentLost.filter((id) => current.some((s) => s.id === id)),
    customFields: fields ?? settings.data.customFields ?? [],
  };

  const move = (index: number, by: number) => {
    const next = [...current];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    const [row] = next.splice(index, 1);
    if (row) next.splice(target, 0, row);
    setStages(next);
  };

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <div className="mb-1 flex items-baseline justify-between">
          <p className="font-medium">Your pipeline</p>
          {settings.data.usingDefaults && !dirty ? (
            <span className="text-xs" style={muted}>
              using the defaults
            </span>
          ) : null}
        </div>
        <p className="mb-3 text-sm" style={muted}>
          The columns on the deals board, left to right. Rename them to match
          what you actually do — a stage keeps its deals when you rename it.
        </p>

        <ul className="space-y-2">
          {current.map((stage, index) => (
            <li key={stage.id} className="flex items-center gap-2">
              <Input
                value={stage.label}
                /*
                 * A row of identical boxes is unusable with a screen reader
                 * without this: every one announces as "edit text", and the
                 * only thing distinguishing them is a visual position.
                 */
                aria-label={`Stage ${index + 1} name`}
                onChange={(e) => {
                  const next = [...current];
                  next[index] = { ...stage, label: e.target.value };
                  setStages(next);
                }}
              />
              <button
                type="button"
                className="px-1 text-sm"
                style={muted}
                aria-label="Move earlier"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="px-1 text-sm"
                style={muted}
                aria-label="Move later"
                disabled={index === current.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="px-1 text-sm link-muted"
                disabled={current.length === 1}
                onClick={() => setStages(current.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-2">
          <Button
            variant="secondary"
            onClick={() =>
              setStages([...current, { id: "", label: "New stage" }])
            }
          >
            Add a stage
          </Button>
        </div>
      </Card>

      <Card>
        <p className="mb-1 font-medium">Task types</p>
        <p className="mb-3 text-sm" style={muted}>
          What a task can be: a call, a site visit, whatever you log.
        </p>
        <div className="flex flex-wrap gap-2">
          {currentTypes.map((type, index) => (
            <span key={type} className="flex items-center gap-1">
              <Input
                value={type}
                className="w-36"
                // A row of identical boxes announces as "edit text" over and
                // over; the position on screen is the only thing telling them
                // apart, and that is what a screen reader user does not have.
                aria-label={`Task type ${index + 1}`}
                onChange={(e) => {
                  const next = [...currentTypes];
                  next[index] = e.target.value;
                  setTypes(next);
                }}
              />
              <button
                type="button"
                className="text-sm link-muted"
                disabled={currentTypes.length === 1}
                onClick={() =>
                  setTypes(currentTypes.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </span>
          ))}
          <Button
            variant="secondary"
            onClick={() => setTypes([...currentTypes, "visit"])}
          >
            Add
          </Button>
        </div>
      </Card>

      {/*
        Which stages mean the work came off.

        Data rather than a hard-coded "won": a business whose last stage is
        "Installed" still needs its dashboard to count that as money in, and
        the chart of won against lost is unanswerable without knowing which
        is which.
      */}
      <Card>
        <p className="mb-1 font-medium">What counts as won and lost</p>
        <p className="mb-3 text-sm" style={muted}>
          The dashboard chart and the pipeline totals read these.
        </p>
        <div className="space-y-1">
          {current.map((stage) => (
            <div key={stage.id} className="flex items-center gap-4 text-sm">
              <span className="w-40 truncate">{stage.label}</span>
              {(
                [
                  ["Won", currentWon, setWon],
                  ["Lost", currentLost, setLost],
                ] as const
              ).map(([label, list, set]) => (
                <label key={label} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={list.includes(stage.id)}
                    onChange={(e) =>
                      // A stage cannot be both. Ticking one unticks the other,
                      // because "won and lost" is not a state a deal can be in
                      // and a chart built on it would double-count the money.
                      set(
                        e.target.checked
                          ? [...list, stage.id]
                          : list.filter((id) => id !== stage.id),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <p className="mb-1 font-medium">Contact statuses</p>
        <p className="mb-3 text-sm" style={muted}>
          How warm a relationship is, coldest first. The order here is the order
          the filter offers them in.
        </p>
        <div className="space-y-2">
          {currentStatuses.map((status, index) => (
            <div key={status.id} className="flex items-center gap-2">
              {/* A colour picker, because these are read as dots in a list of
                  two hundred contacts rather than read as words. */}
              <input
                type="color"
                value={status.color}
                aria-label={`Colour for ${status.label}`}
                className="h-8 w-10 rounded border"
                style={border}
                onChange={(e) => {
                  const next = [...currentStatuses];
                  next[index] = { ...status, color: e.target.value };
                  setStatuses(next);
                }}
              />
              <Input
                value={status.label}
                className="w-48"
                aria-label={`Name for ${status.label}`}
                onChange={(e) => {
                  const next = [...currentStatuses];
                  next[index] = { ...status, label: e.target.value };
                  setStatuses(next);
                }}
              />
              <button
                type="button"
                className="text-sm link-muted"
                disabled={currentStatuses.length === 1}
                onClick={() =>
                  setStatuses(currentStatuses.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              setStatuses([
                ...currentStatuses,
                { id: "", label: "New status", color: "#94a3b8" },
              ])
            }
          >
            Add a status
          </Button>
        </div>
      </Card>

      <WordList
        title="Deal categories"
        hint="What kind of work a deal is. Offered on the board's filter."
        values={currentCategories}
        placeholder="Maintenance"
        onChange={setCategories}
      />

      <WordList
        title="Company sectors"
        hint="The industries you sell into. Offered on the companies filter."
        values={currentSectors}
        placeholder="Construction"
        onChange={setSectors}
      />

      {dirty ? (
        <Card>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => save.mutate(pending)}
              disabled={save.isPending}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
            <button
              type="button"
              className="text-sm link-muted"
              onClick={() => {
                setStages(null);
                setTypes(null);
                setStatuses(null);
                setCategories(null);
                setSectors(null);
                setWon(null);
                setLost(null);
              }}
            >
              Discard
            </button>
          </div>
          {save.error ? <ErrorNote error={save.error} /> : null}
        </Card>
      ) : null}

      <Card>
        <p className="mb-1 font-medium">Tags</p>
        <p className="mb-3 text-sm" style={muted}>
          Labels you put on contacts. Deleting one takes it off everybody who
          has it.
        </p>

        {tags.data?.tags.length ? (
          <ul className="mb-3 space-y-1">
            {tags.data.tags.map((tag) => (
              <li
                key={tag.id}
                className="flex items-center gap-3 border-t py-2 first:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 rounded-full"
                  style={{ background: tag.color }}
                />
                <span className="flex-1 text-sm">{tag.name}</span>
                <span className="flex gap-1">
                  {TAG_COLOURS.map((colour) => (
                    <button
                      key={colour}
                      type="button"
                      // Named per colour rather than per tag: eight buttons
                      // all announced "Colour Retainer" say nothing about
                      // which one you are on.
                      aria-label={`${colour} for ${tag.name}`}
                      aria-pressed={colour === tag.color}
                      /*
                       * The dot stays 16px and the target around it is 24.
                       *
                       * WCAG 2.2 asks 24px, and a 16px circle is something you
                       * can see and cannot reliably hit — which is most of the
                       * point for somebody whose hands are not steady. Making
                       * the dot itself bigger would have changed the design;
                       * this changes only what a finger has to find.
                       */
                      className="grid size-6 place-items-center rounded-full"
                      onClick={() =>
                        recolour.mutate({ id: tag.id, color: colour })
                      }
                    >
                      <span
                        aria-hidden="true"
                        className="block size-4 rounded-full border"
                        style={{
                          background: colour,
                          borderColor:
                            colour === tag.color
                              ? "var(--text)"
                              : "transparent",
                        }}
                      />
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  className="text-sm link-muted"
                  onClick={() => removeTag.mutate(tag.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-sm" style={muted}>
            No tags yet.
          </p>
        )}

        <Field label="Add a tag">
          <div className="flex gap-2">
            <Input
              value={newTag}
              placeholder="Repeat customer"
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTag.trim()) {
                  e.preventDefault();
                  addTag.mutate(newTag.trim());
                }
              }}
            />
            <Button
              onClick={() => addTag.mutate(newTag.trim())}
              disabled={!newTag.trim() || addTag.isPending}
            >
              Add
            </Button>
          </div>
        </Field>
        {addTag.error ? <ErrorNote error={addTag.error} /> : null}
        {removeTag.error ? <ErrorNote error={removeTag.error} /> : null}
      </Card>

      {/* Pro. Whatever a business already defined stays on screen and stays
          readable — that is the promise a lapsed licence has to keep — but the
          editor is not offered, because the route refuses a change and a form
          that cannot save is worse than one that is not there. */}
      {tier === "pro" ? (
        <CustomFieldEditor
          subjects={CRM_SUBJECTS}
          fields={fields ?? settings.data.customFields ?? []}
          onChange={setFields}
        />
      ) : (settings.data.customFields ?? []).length > 0 ? (
        <Card>
          <p className="mb-2 font-medium">Custom fields</p>
          <ul className="text-sm" style={muted}>
            {(settings.data.customFields ?? []).map((f) => (
              <li key={f.id}>
                {f.label} — {f.type}, on {f.appliesTo}s
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm" style={muted}>
            These are still in use and still readable. Changing them, or adding
            another, is part of Pro.
          </p>
        </Card>
      ) : null}

      <EmailCapture />
    </div>
  );
}

/**
 * Email that files itself.
 *
 * A business CCs one address on the mail it already sends, and the message
 * lands on the customer's record. The setup is the part everybody gets wrong:
 * this shows the address to give the mail provider, and the URL to point it
 * at, rather than asking somebody to edit a file on a server.
 */
function EmailCapture() {
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["crm-inbound"],
    queryFn: () =>
      api<{
        enabled: boolean;
        address: string | null;
        webhookUrl: string | null;
      }>("/api/crm/inbound"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["crm-inbound"] });

  const turnOn = useMutation({
    mutationFn: () =>
      api("/api/crm/inbound", {
        method: "POST",
        body: JSON.stringify({ address: address || data?.address }),
      }),
    onSuccess: () => {
      setCopied(false);
      refresh();
    },
  });

  const turnOff = useMutation({
    mutationFn: () => api("/api/crm/inbound", { method: "DELETE" }),
    onSuccess: refresh,
  });

  if (isLoading) return <Loading />;

  return (
    <Card>
      <p className="font-medium">Capture email</p>
      <p className="mb-3 text-sm" style={muted}>
        CC one address on the mail you already send, and it lands on that
        customer's record as a note. Mail from an address nobody here has is
        dropped rather than filed against a guess.
      </p>

      <Field
        label="The address you CC"
        hint="Whatever your mail provider forwards to Sentrello."
      >
        <Input
          value={address || (data?.address ?? "")}
          placeholder="crm@yourbusiness.com"
          onChange={(e) => setAddress(e.target.value)}
        />
      </Field>

      {data?.enabled && data.webhookUrl ? (
        <div className="mt-3">
          <p className="text-sm font-medium">Point your provider here</p>
          <p className="text-xs" style={muted}>
            This URL is the credential. Anybody holding it can write notes onto
            your contacts, so treat it like a password — and rotate it below if
            it goes anywhere it should not.
          </p>
          <div className="mt-1 flex items-center gap-2">
            <Input
              readOnly
              value={data.webhookUrl}
              className="font-mono w-full text-xs"
            />
            <Button
              variant="secondary"
              onClick={() => {
                navigator.clipboard?.writeText(data.webhookUrl ?? "");
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <Button onClick={() => turnOn.mutate()} disabled={turnOn.isPending}>
          {data?.enabled ? "Rotate the URL" : "Turn it on"}
        </Button>
        {data?.enabled ? (
          <Button
            variant="secondary"
            onClick={() => turnOff.mutate()}
            disabled={turnOff.isPending}
          >
            Turn it off
          </Button>
        ) : null}
      </div>

      {turnOn.error ? <ErrorNote error={turnOn.error} /> : null}
      {turnOff.error ? <ErrorNote error={turnOff.error} /> : null}
    </Card>
  );
}

/**
 * A plain list of short labels, edited in place.
 *
 * Deal categories and company sectors are the same shape and the same
 * interaction; one component rather than two near-identical blocks.
 */
function WordList({
  title,
  hint,
  values,
  placeholder,
  onChange,
}: {
  title: string;
  hint: string;
  values: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <Card>
      <p className="mb-1 font-medium">{title}</p>
      <p className="mb-3 text-sm" style={muted}>
        {hint}
      </p>
      <div className="flex flex-wrap gap-2">
        {values.map((value, index) => (
          // No stable id: these are the labels themselves, and two blank rows
          // while somebody is typing are legitimately equal.
          // biome-ignore lint/suspicious/noArrayIndexKey: the value is the identity and it changes as you type
          <span key={index} className="flex items-center gap-1">
            <Input
              value={value}
              className="w-40"
              aria-label={`${title} ${index + 1}`}
              onChange={(e) => {
                const next = [...values];
                next[index] = e.target.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              className="text-sm link-muted"
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </span>
        ))}
        <Button
          variant="secondary"
          onClick={() => onChange([...values, placeholder])}
        >
          Add
        </Button>
      </div>
    </Card>
  );
}

/**
 * The fields a business adds for itself.
 *
 * A plumber keeps "boiler model" against a contact; a builder keeps "site
 * access" against a deal. Neither is worth a release, and a CRM that cannot
 * hold the one thing they actually look up is a CRM with a spreadsheet beside
 * it.
 *
 * Saved with the rest of the settings, on the same press: a field defined but
 * not saved is a form that changes shape when nobody asked it to.
 */

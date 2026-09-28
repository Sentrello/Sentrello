export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * What the server said, when it said anything.
     *
     * The server often knows why — "this customer has 3 invoices" — and that
     * sentence is more use to someone than any status code. Kept separate so
     * a screen can choose to show it rather than being handed a raw message
     * meant for a log.
     */
    readonly serverMessage?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(
      res.status,
      `${init?.method ?? "GET"} ${path} failed`,
      typeof body?.error === "string" ? body.error : undefined,
    );
  }
  return (await res.json()) as T;
}

export type Meta = {
  /**
   * The actions this person holds, by resource — `{ crm: ["read", "create"] }`.
   *
   * For deciding what to *offer*, never for deciding what is safe: the route
   * enforces the same rule and is the only thing standing between a request
   * and the data. A screen that reads this is being polite, not being a gate.
   */
  can?: Record<string, string[]>;
  /** The business's own country, and the whole of how it writes a number. */
  countryCode?: string;
  /** The release this instance runs, used to key module scripts by version. */
  version?: string;
  /** `moduleId` is which module registered the entry, and owns its screens. */
  nav: {
    id: string;
    label: string;
    order?: number;
    moduleId: string;
    group?: string;
    /** Set on a module's own pages: the id of the entry they sit under. */
    parent?: string;
    icon?: string;
  }[];
  loaded: string[];
  /**
   * Every optional module this licence allows, and whether it is set up.
   *
   * One that is not set up appears nowhere else: it is deliberately absent
   * from the sidebar until somebody turns it on.
   */
  modules: { id: string; label: string; enabled: boolean }[];
  /** module ids that shipped screens this instance may serve */
  ui: string[];
  /**
   * Paid modules that are not running, for whoever can act on it.
   *
   * Sent only to somebody whose role can open the licence screen; empty on a
   * healthy instance, and on every Free one.
   */
  failed?: string[];
  /** What this instance is licensed for, so a screen can offer its Pro half. */
  tier?: "free" | "pro";
  /**
   * Whether this person is part of the business running this instance.
   *
   * False for a billing-only account — someone who bought Sentrello and has a
   * login purely to manage what they pay for. They see none of the
   * application.
   */
  belongsHere?: boolean;
  /** Where such a person belongs instead, on the instance that sells Sentrello. */
  accountPath?: string | null;
};

export type LabelledValue = { label: string; value: string };

/**
 * A column a module worked out for this record, keyed by the column's key.
 *
 * Never stored and never written: the server computes these as it reads, so a
 * figure counting days is right on the day it is read rather than on the day
 * somebody last saved the record. Absent on an instance where nothing
 * registers any, which is what a Free list looks like.
 */
export type ComputedValues = Record<
  string,
  { value: number | string | null; reason?: string }
>;

export type Contact = {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  companyId: string | null;
  /**
   * Where they work, resolved for the page by the list route.
   *
   * Sent with the row rather than looked up in the browser: the screens that
   * needed it used to fetch every company to build a lookup table, and that
   * route stops at a thousand rows.
   */
  companyName?: string | null;
  /** Stored filename of the resized WebP, or null. Never the bytes. */
  avatarPath?: string | null;
  email: string | null;
  phone: string | null;
  /** Every other way to reach them, beyond the first of each. */
  emails: LabelledValue[] | null;
  phones: LabelledValue[] | null;
  kind: string;
  /** How warm the relationship is. The stored id, not the label. */
  status: string;
  background: string | null;
  linkedinUrl: string | null;
  hasNewsletter: boolean;
  /** They asked not to have their information sold or shared (CCPA). */
  doNotSell: boolean;
  doNotSellOn: string | null;
  gender: string | null;
  ownerId: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** Attached by the list route, so a row can draw them without a second call. */
  tags?: Tag[];
  openTasks?: number;
  /** Whatever this business added for itself, keyed by field id. */
  customValues?: Record<string, string | number | boolean | null> | null;
  /** Worked out on read by whatever module defines computed columns. */
  computed?: ComputedValues;
};

export type Tag = { id: string; name: string; color: string };

export type Company = {
  /** Whatever this business added for itself, keyed by field id. */
  customValues?: Record<string, string | number | boolean | null> | null;
  id: string;
  name: string;
  website: string | null;
  logoPath?: string | null;
  sector: string | null;
  size: number | null;
  phone: string | null;
  linkedinUrl: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  revenue: string | null;
  description: string | null;
  taxIdentifier: string | null;
  /** What VIES said about the identifier, and when. Null: never checked. */
  taxIdentifierValid?: boolean | null;
  taxIdentifierCheckedAt?: string | null;
  taxIdentifierCheckedName?: string | null;
  contextLinks: string[] | null;
  ownerId: string | null;
  createdAt: string;
  /** Attached by the list route so a card can draw itself in one request. */
  contacts?: { id: string; name: string; avatarPath: string | null }[];
  contactCount?: number;
  dealCount?: number;
  /** Worked out on read by whatever module defines computed columns. */
  computed?: ComputedValues;
};

/**
 * Headcount bands, matching the reference's.
 *
 * Bands rather than a number because nobody knows the number, and the stored
 * value is the top of the band so it sorts correctly.
 */
export const COMPANY_SIZES = [
  { id: 1, label: "1 employee" },
  { id: 10, label: "2–9 employees" },
  { id: 50, label: "10–49 employees" },
  { id: 250, label: "50–249 employees" },
  { id: 500, label: "250 or more employees" },
];

/** Money is integer cents on the wire, as it is everywhere else. */
export type Invoice = {
  id: string;
  number: string;
  contactId: string | null;
  status: string;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  dueDate: string | null;
  issuedAt: string | null;
};

export type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
  description?: string | null;
  parentId?: string | null;
  archivedAt?: string | null;
  /** Whether the business banks with it, and which bank. */
  isBank?: boolean;
  bankName?: string | null;
  /** Only ever the last four digits — enough to recognise, useless to steal. */
  bankAccountLast4?: string | null;
};

export type Expense = {
  id: string;
  vendor: string | null;
  amountCents: number;
  spentAt: string;
  accountId: string | null;
};

export type ProfitAndLoss = {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
};

/** Money in or out that did not come from an invoice. */
export type Transaction = {
  id: string;
  kind: "income" | "expense";
  accountId: string | null;
  paidThroughAccountId: string | null;
  amountCents: number;
  occurredAt: string;
  description: string | null;
  reference: string | null;
  method: string | null;
  reversedAt: string | null;
};

export type FormDefinition = {
  id: string;
  key: string;
  name: string;
  kind: string;
  /** Which form a submission came from; every form collects a name. */
  tag?: string | null;
  fields?: { name: string; label: string; type: string; required?: boolean }[];
  style?: { accent?: string; radius?: string } | null;
  /** Where the visitor lands after submitting, and who gets told they did. */
  redirectUrl?: string | null;
  notifyEmail?: string | null;
  submissionCount?: number;
};

/**
 * Whether this person may do something, for a screen deciding what to offer.
 *
 * A module-level value set once when the shell's meta lands, rather than a
 * hook reading the query cache — the same shape `setFormats` in `ui.tsx` uses
 * and for a sharper version of the same reason. `Button` reads this, there
 * are several hundred buttons, and a hook inside a primitive makes a
 * `QueryClientProvider` a requirement of rendering one. That is a real cost:
 * it broke three sign-in tests that render a button and have no business
 * knowing what a query client is.
 *
 * Permissions do not change while somebody is looking at a screen, and when
 * the meta query does answer again the shell re-renders the tree under it.
 *
 * **Unknown means allowed.** A resource absent from the set — because the
 * fetch has not landed, because this person belongs to no organization yet,
 * because a module declared a resource the server has not compiled — comes
 * back `true`. Hiding a control from somebody entitled to it is the worse of
 * the two mistakes, and it is the rule the sidebar already follows. The route
 * refuses what it must; this only decides what looks available.
 */
let grants: Record<string, string[]> | null = null;

/** Called by the shell when `/api/_meta` answers. */
export function setGrants(next: Record<string, string[]> | undefined): void {
  grants = next ?? null;
}

export function may(resource: string, action: string): boolean {
  const held = grants?.[resource];
  if (!held) return true;
  return held.includes(action);
}

/**
 * Which modules this instance actually loaded.
 *
 * The opposite default to `may` above, and deliberately. A permission we
 * have not been told about is allowed, because hiding a control from
 * somebody entitled to it is the worse mistake and the route refuses what
 * it must anyway. A *route* we have not been told about is absent: asking
 * for it costs a round trip and answers 404, and the screen has already
 * decided what to do without it.
 *
 * This exists because the profit and loss asked a Pro endpoint for its
 * class list on every Free instance, twice a screen, and took a 404 in the
 * console each time in front of whoever had opened it.
 */
let loadedModules: string[] = [];

/** Called by the shell when `/api/_meta` answers. */
export function setLoadedModules(next: string[] | undefined): void {
  loadedModules = next ?? [];
}

export function hasModule(id: string): boolean {
  return loadedModules.includes(id);
}

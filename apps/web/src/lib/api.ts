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

export type Contact = {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  companyId: string | null;
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
  contextLinks: string[] | null;
  ownerId: string | null;
  createdAt: string;
  /** Attached by the list route so a card can draw itself in one request. */
  contacts?: { id: string; name: string; avatarPath: string | null }[];
  contactCount?: number;
  dealCount?: number;
};

/**
 * Headcount bands, matching Atomic's.
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

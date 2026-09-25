import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Meta, api } from "../lib/api";
import {
  Button,
  Card,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  SecretInput,
  SectionHeading,
  Select,
  Textarea,
  Toolbar,
  Warning,
  muted,
} from "../lib/ui";

interface LicenseResponse {
  tier: string;
  valid: boolean;
  /** False on an instance that has no licence token at all — plain Free. */
  tokenPresent: boolean;
  reason: string | null;
  modules: string[];
  seats: number | null;
  instanceId: string | null;
  tokenExpiresAt: string | null;
  graceUntil: string | null;
  modulesLoaded: string[];
  failedBundles: { name: string; reason: string }[];
}

/**
 * `reason` on `/api/license` is whatever `jose` said while verifying the
 * token — "Invalid Compact JWS", `"exp" claim timestamp check failed`,
 * "signature verification failed". Exactly right for a log line, and
 * meaningless to the business owner it was being shown to verbatim: "Running
 * as Free: Invalid Compact JWS" answers nothing for someone who did not write
 * the verifier. Matched by substring rather than exact string, because the
 * library's wording is not a contract this screen can pin to a release.
 */
export function friendlyLicenseReason(reason: string | null): string | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (r.includes('"exp"') || r.includes("expired")) {
    return "this licence has expired";
  }
  if (r.includes('"iss"') || r.includes("issuer")) {
    return "this token was not issued by sentrello.com";
  }
  if (r.includes("signature")) {
    return "this licence does not check out — it may be for a different instance, or damaged in transit";
  }
  return "this does not look like a valid licence token";
}

/** The editable half of the business card, held and saved as one. */
interface BusinessDetails {
  address: string;
  taxId: string;
  taxIdLabel: string;
  paymentInstructions: string;
  city: string;
  postcode: string;
  countryCode: string;
  email: string;
  phone: string;
  iban: string;
  timezone: string;
  /** Null is untouched, empty is removed, anything else is the business's. */
  creditText: string | null;
  creditUrl: string;
}

interface SettingsResponse {
  business: {
    name: string;
    slug: string;
    address: string;
    taxId: string;
    taxIdLabel: string;
    paymentInstructions: string;
    city: string;
    postcode: string;
    countryCode: string;
    email: string;
    phone: string;
    iban: string;
    timezone: string;
    /**
     * Three-valued on purpose: null is untouched (the Sentrello line shows),
     * empty is removed, anything else is the business's own line.
     */
    creditText: string | null;
    creditUrl: string;
    /** Free carries ours and cannot change it. */
    canSetCredit: boolean;
  };
  instance: { baseUrl: string; baseUrlMatchesRequest: boolean };
  telemetry: { enabled: boolean; fixedOnServer: boolean };
  email: { configured: boolean; from: string | null };
  payments: {
    stripe: {
      configured: boolean;
      webhookConfigured: boolean;
      testMode: boolean;
      webhookUrl: string;
    };
    paypal: {
      configured: boolean;
      webhookConfigured: boolean;
      environment: string;
      webhookUrl: string;
    };
  };
}

/** Green when it is set up, amber when it is not — never a bare boolean. */
function State({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span
      className="text-sm font-medium"
      style={{ color: ok ? "var(--text-success)" : "var(--text-warning)" }}
    >
      {ok ? yes : no}
    </span>
  );
}

/**
 * A value shown in full, and copied in one press.
 *
 * It used to truncate. A webhook URL or an instance id cut off with an
 * ellipsis is a value somebody cannot read back to support, cannot check
 * against what they pasted into Stripe, and cannot type on another machine —
 * and the one time they need it is the time the clipboard is not an option.
 * It wraps instead.
 */
function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      <p className="text-xs" style={muted}>
        {label}
        {copied ? <span className="ml-2">copied</span> : null}
      </p>
      <button
        type="button"
        className="w-full break-all rounded border px-2 py-1 text-left text-xs border-line"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            // A denied clipboard is not worth an error; the value is on screen
            // and can be selected.
            () => undefined,
          );
        }}
        title="Copy"
      >
        {value}
      </button>
    </div>
  );
}

interface UpdatesResponse {
  current: string;
  latest: string | null;
  rollbackTo: string | null;
  updateAvailable: boolean;
  canApply: boolean;
  /** Whether this instance has somewhere to ask. Free asks only when pressed. */
  canCheck: boolean;
  /** Something other than this screen owns the version — a deploy script. */
  managedExternally: boolean;
  status: { state: string; message?: string; version?: string; at?: string };
}

/**
 * Settings, as four pages rather than one scroll.
 *
 * It was one screen with nine cards on it: the business's own name beside a
 * webhook URL beside a rollback button. Somebody looking for their VAT number
 * had to read past the licence, and somebody applying an update had to scroll
 * past the address. Four pages, in the sidebar, because that is where the rest
 * of the product puts its screens.
 */
export function Settings() {
  const qc = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  // Held together, because they are saved together: partial identity on an
  // invoice is worse than none, since it looks deliberate.
  const [details, setDetails] = useState<BusinessDetails | null>(null);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("/api/settings"),
  });
  // No error branch on purpose: the one thing this draws here is the instance
  // identifier under "This instance", and a line of small grey text that goes
  // missing tells nobody anything false. The settings query above has a note.
  const licence = useQuery({
    queryKey: ["license"],
    queryFn: () => api<LicenseResponse>("/api/license"),
  });

  const rename = useMutation({
    mutationFn: (body: Record<string, string | null>) =>
      api("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      setName(null);
      setDetails(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  const data = settings.data;
  if (!data) return null;

  const saved = {
    address: data.business.address,
    taxId: data.business.taxId,
    taxIdLabel: data.business.taxIdLabel,
    paymentInstructions: data.business.paymentInstructions,
    city: data.business.city,
    postcode: data.business.postcode,
    countryCode: data.business.countryCode,
    email: data.business.email,
    phone: data.business.phone,
    iban: data.business.iban,
    timezone: data.business.timezone,
    creditText: data.business.creditText,
    creditUrl: data.business.creditUrl,
  };
  const form = details ?? saved;
  const patch = (change: Partial<BusinessDetails>) =>
    setDetails({ ...form, ...change });
  const dirty =
    (name !== null && name !== data.business.name) ||
    (Object.keys(saved) as (keyof typeof saved)[]).some(
      (k) => form[k] !== saved[k],
    );

  return (
    <Page width="prose">
      <Card>
        <SectionHeading>Your business</SectionHeading>
        <div className="flex flex-col gap-(--gap-stack)">
          <Field
            label="Name"
            hint="Appears on invoices, the customer portal and your storefront."
          >
            <Input
              value={name ?? data.business.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          {/*
            An invoice with only a name is not a valid document in the UK or
            the EU, and a business paid by transfer whose invoices omit its
            account details answers "where do I send this?" on every one.
          */}
          <Field
            label="Address"
            hint="Required on invoices in the UK and EU. Appears at the foot of every one."
          >
            <Textarea
              rows={3}
              value={form.address}
              onChange={(e) => patch({ address: e.target.value })}
            />
          </Field>

          {/*
            The same address, in the parts a machine reads. A structured
            e-invoice cannot take a country out of a line somebody typed, and
            Germany will not accept one without the city and postcode stated
            as themselves.
          */}
          <div className="grid gap-(--gap-toolbar) sm:grid-cols-[1fr_8rem_6rem]">
            <Field label="City" hint="For structured e-invoices.">
              <Input
                value={form.city}
                onChange={(e) => patch({ city: e.target.value })}
              />
            </Field>
            <Field label="Postcode">
              <Input
                value={form.postcode}
                onChange={(e) => patch({ postcode: e.target.value })}
              />
            </Field>
            <Field label="Country" hint='Two letters — "DE", "GB".'>
              <Input
                value={form.countryCode}
                placeholder="DE"
                onChange={(e) => patch({ countryCode: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-(--gap-toolbar) sm:grid-cols-2">
            <Field
              label="Email"
              hint="A contact point for invoices. Germany requires one."
            >
              <Input
                value={form.email}
                onChange={(e) => patch({ email: e.target.value })}
              />
            </Field>
            <Field label="Phone">
              <Input
                value={form.phone}
                onChange={(e) => patch({ phone: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-(--gap-toolbar) sm:grid-cols-[10rem_1fr]">
            <Field label="Tax number label" hint="e.g. VAT number, ABN, EIN.">
              <Input
                value={form.taxIdLabel}
                placeholder="VAT number"
                onChange={(e) => patch({ taxIdLabel: e.target.value })}
              />
            </Field>
            {/* Only the last four characters ever leave the server, the way a
                tax file number or an SSN is shown anywhere else. Typing over
                the mask replaces it; leaving it alone keeps what is stored. */}
            <Field
              label="Tax number"
              hint={
                data.business.taxId
                  ? "Hidden for safety. Type a new one to replace it."
                  : "Leave blank if you are not registered."
              }
            >
              <Input
                value={form.taxId}
                onChange={(e) => patch({ taxId: e.target.value })}
              />
            </Field>
          </div>

          {/* The machine-readable half of "how to pay": an e-invoice carries
              the account itself, and Germany refuses one without it. */}
          <Field
            label="IBAN"
            hint="Where bank transfers go. Required on German e-invoices."
          >
            <Input
              value={form.iban}
              placeholder="DE89 3704 0044 0532 0130 00"
              onChange={(e) => patch({ iban: e.target.value })}
            />
          </Field>

          <Field
            label="How to pay"
            hint="Bank details or instructions, shown on the customer's page."
          >
            <Textarea
              rows={3}
              value={form.paymentInstructions}
              onChange={(e) => patch({ paymentInstructions: e.target.value })}
            />
          </Field>

          {/*
            The line at the foot of a page a visitor lands on.

            Free carries "Powered by Sentrello" and cannot change it — that is
            part of what Free is, and for most people it is the only place they
            will ever see the product named. Pro is paid for, so it is the
            business's: their own credit, or an empty one to say nothing at all.

            Offered only where it does something. A field that silently did
            nothing is a setting somebody sets and then wonders about.
          */}
          {data.business.canSetCredit ? (
            <>
              <Field
                label="Credit on your public pages"
                hint="The line at the foot of your sign-in and thank-you pages."
              >
                <Select
                  value={
                    form.creditText === null
                      ? "sentrello"
                      : form.creditText === ""
                        ? "none"
                        : "own"
                  }
                  onChange={(e) => {
                    const mode = e.target.value;
                    if (mode === "sentrello") {
                      patch({ creditText: null, creditUrl: "" });
                    } else if (mode === "none") {
                      patch({ creditText: "" });
                    } else {
                      // Seeded with the business's name so "your own line" is
                      // never an empty box — an empty line is a removed one.
                      patch({ creditText: data.business.name });
                    }
                  }}
                >
                  <option value="sentrello">Powered by Sentrello</option>
                  <option value="own">Your own line</option>
                  <option value="none">No line at all</option>
                </Select>
              </Field>
              {form.creditText !== null ? (
                <div className="grid gap-(--gap-toolbar) sm:grid-cols-2">
                  <Field
                    label="Your line"
                    hint="Clearing it removes the line entirely."
                  >
                    <Input
                      value={form.creditText}
                      placeholder="Built by Pike & Co"
                      onChange={(e) => patch({ creditText: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="Where it links"
                    hint="Optional. Opens in a new tab."
                  >
                    <Input
                      value={form.creditUrl ?? ""}
                      placeholder="https://pike.example"
                      onChange={(e) => patch({ creditUrl: e.target.value })}
                    />
                  </Field>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm" style={muted}>
              Your sign-in and thank-you pages carry{" "}
              <strong>Powered by Sentrello</strong>. Pro replaces it with your
              own line, or removes it.
            </p>
          )}

          {/*
            Where the business is, in time.
            
            Anything that acts at a time of day depends on it: an automation
            chasing quiet deals every Monday at nine goes out on Sunday evening
            for a business whose server is in another country, and nothing
            anywhere says why. Offered with the browser's own answer, because
            the person filling this in is standing in the business.
          */}
          <Field
            label="Timezone"
            hint="What 'nine o'clock' means for this business. Leave it blank to use the server's own."
          >
            <Toolbar>
              <Input
                value={form.timezone}
                placeholder="Europe/London"
                onChange={(e) => patch({ timezone: e.target.value })}
              />
              <Button
                variant="secondary"
                onClick={() =>
                  patch({
                    timezone:
                      Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
                  })
                }
              >
                Use mine
              </Button>
            </Toolbar>
          </Field>

          <Button
            onClick={() =>
              rename.mutate({ name: name ?? data.business.name, ...form })
            }
            disabled={
              rename.isPending || !(name ?? data.business.name) || !dirty
            }
          >
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        {rename.error ? <ErrorNote error={rename.error} /> : null}
      </Card>

      <TaxRegimesCard />

      <Card>
        <SectionHeading>This instance</SectionHeading>
        <p className="text-sm" style={muted}>
          Links in emails are built from {data.instance.baseUrl}.
        </p>
        {licence.data?.instanceId ? (
          <p className="mt-1 text-xs" style={muted}>
            Instance {licence.data.instanceId}
          </p>
        ) : null}
        {!data.instance.baseUrlMatchesRequest ? (
          // The reason a customer receives a link pointing at localhost.
          <p className="mt-1 text-sm" style={{ color: "var(--text-warning)" }}>
            That does not match the address you are using right now. Links sent
            to customers may not work until the server's configured address is
            corrected.
          </p>
        ) : null}
      </Card>

      <SettingUpRestore />
    </Page>
  );
}

interface TaxRegimesResponse {
  regimes: { id: string; label: string }[];
  chosen: string[];
  default: string[];
}

/**
 * Which tax regimes this business operates in.
 *
 * Not one country — a set, because selling across borders is ordinary and
 * turns on more than one regime at once. Unchecking one never touches a
 * filing already made; it only hides the screen from the sidebar. A business
 * that starts selling somewhere new, or stops, comes back here.
 */
function TaxRegimesCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["tax-regimes"],
    queryFn: () => api<TaxRegimesResponse>("/api/tax-regimes"),
  });
  const [pending, setPending] = useState<string[] | null>(null);
  const [emptying, setEmptying] = useState(false);

  const save = useMutation({
    mutationFn: (regimes: string[]) =>
      api("/api/tax-regimes", {
        method: "PUT",
        body: JSON.stringify({ regimes }),
      }),
    onSuccess: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: ["tax-regimes"] });
      // The sidebar reads this list too, so a regime turned off leaves it
      // straight away rather than waiting for something else to refetch it.
      qc.invalidateQueries({ queryKey: ["meta"] });
    },
  });

  if (isLoading || !data) return null;
  const chosen = pending ?? data.chosen;

  const apply = (next: string[]) => {
    setPending(next);
    save.mutate(next);
  };

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...chosen, id] : chosen.filter((x) => x !== id);
    // Emptying the set entirely is a real choice a business can make — but
    // rarely the one somebody meant by unchecking the last box, so it is
    // asked rather than saved on the spot.
    if (next.length === 0) {
      setEmptying(true);
      return;
    }
    apply(next);
  };

  return (
    <Card>
      <SectionHeading>Tax regimes</SectionHeading>
      <p className="mb-3 text-sm" style={muted}>
        Which of these you operate in decides what shows in the sidebar. Sell
        only at home and pick one; sell across borders and pick several —
        turning one off keeps everything already filed under it, it only hides
        the screen.
      </p>
      <div className="flex flex-col gap-(--gap-toolbar)">
        {data.regimes.map((r) => (
          <label
            key={r.id}
            className="flex items-center gap-(--gap-tight) text-sm"
          >
            <input
              type="checkbox"
              checked={chosen.includes(r.id)}
              onChange={(e) => toggle(r.id, e.target.checked)}
            />
            {r.label}
          </label>
        ))}
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
      {/*
        The checkbox has already sprung back, because `chosen` never changed.
        So the dialog is the whole of the decision: leaving it puts nothing
        right, because nothing went wrong.
      */}
      <Dialog
        title="Turn off every tax regime?"
        open={emptying}
        onClose={() => setEmptying(false)}
      >
        <div className="flex flex-col gap-(--gap-stack)">
          <p className="text-sm">
            You will see none of the VAT, Canadian tax or US sales tax screens
            until you turn one back on. Everything already filed under them
            stays where it is.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEmptying(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setEmptying(false);
                apply([]);
              }}
            >
              Turn them all off
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

/**
 * The way back for a hidden setting-up checklist.
 *
 * What makes hiding the checklist safe to offer at all: somebody who put it
 * away part-way can bring it back, and it resumes where the data says it is.
 * The card only exists while there is something to bring back — a checklist
 * that was finished has nothing to restore, and offering it anyway would be
 * a control that does nothing.
 */
function SettingUpRestore() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["dashboard", "onboarding"],
    queryFn: () => api<{ hidden: number }>("/api/dashboard/onboarding"),
    retry: false,
  });
  const restore = useMutation({
    mutationFn: () =>
      api("/api/dashboard/onboarding/restore", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  if (!data || data.hidden === 0) return null;

  return (
    <Card>
      <SectionHeading>Setting up</SectionHeading>
      <p className="text-sm" style={muted}>
        The setting-up checklist was hidden with steps still to do. Bring it
        back and it carries on from where it stands — anything done in the
        meantime is already ticked.
      </p>
      <Button
        className="mt-3"
        onClick={() => restore.mutate()}
        disabled={restore.isPending}
      >
        {restore.isPending ? "Restoring…" : "Show it on the dashboard again"}
      </Button>
      {restore.error ? <ErrorNote error={restore.error} /> : null}
    </Card>
  );
}

/**
 * What this instance is connected to.
 *
 * Email and the payment processors: the three things that are configured on
 * the server and then wondered about for a week. Every one of them says
 * whether it is set up, never a bare boolean, and never what the secret is.
 */
export function SettingsIntegrations() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("/api/settings"),
  });

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  const data = settings.data;
  if (!data) return null;

  return (
    <Page width="prose">
      <Card>
        <SectionHeading
          trailing={
            <State ok={data.email.configured} yes="working" no="not set up" />
          }
        >
          Email
        </SectionHeading>
        <p className="text-sm" style={muted}>
          {data.email.configured
            ? `Sent from ${data.email.from ?? "the configured address"}.`
            : "Invoices, receipts and password resets cannot be delivered until an email provider is configured on the server. Overdue invoices are not chased either — they are left alone rather than marked as chased, so nothing is lost by setting this up later."}
        </p>
      </Card>

      <PaymentConnections
        stripeWebhook={data.payments.stripe.webhookUrl}
        paypalWebhook={data.payments.paypal.webhookUrl}
      />
    </Page>
  );
}

interface PaymentAccountRow {
  id: string;
  provider: string;
  mode: string;
  publicKey: string | null;
  secretHint: string | null;
  hasWebhookSecret: boolean;
  enabled: boolean;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  accountLabel: string | null;
}

/**
 * Connecting a card processor, from a screen.
 *
 * The flow a business already knows from WooCommerce or Shopify: paste the
 * keys, press Test, see who you are connected to, take a payment in the
 * sandbox until it looks right, then turn on live. The previous answer to "how
 * do I take card payments for an invoice" was three environment variables and
 * a restart, which is not something the owner of a business is going to do.
 *
 * Nothing here ever shows a secret. The last four characters are enough for
 * somebody to recognise their own key, and useless to anybody else.
 */
function PaymentConnections({
  stripeWebhook,
  paypalWebhook,
}: {
  stripeWebhook: string;
  paypalWebhook: string;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["payment-accounts"],
    queryFn: () =>
      api<{
        accounts: PaymentAccountRow[];
        canStoreSecrets: boolean;
        environmentFallback: {
          account: string | null;
          hint: string;
          live: boolean;
        } | null;
      }>("/api/payments/accounts"),
  });
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["payment-accounts"] });

  if (isLoading) return null;

  return (
    <>
      {data && !data.canStoreSecrets ? (
        <Card>
          <p className="font-medium" style={{ color: "var(--text-warning)" }}>
            This instance cannot store credentials
          </p>
          <p className="mt-1 text-sm" style={muted}>
            Keys are sealed before they are written down, and there is no secret
            configured to seal them with. Set one on the server and this screen
            will work.
          </p>
        </Card>
      ) : null}

      {data?.environmentFallback ? (
        <Card>
          <p className="font-medium" style={{ color: "var(--text-warning)" }}>
            Card payments are using a key set on the server
          </p>
          <p className="mt-1 text-sm" style={muted}>
            Nothing is connected here, so this instance falls back to the
            <code className="mx-1">STRIPE_SECRET_KEY</code> in its environment —
            ending {data.environmentFallback.hint}
            {data.environmentFallback.account
              ? `, which belongs to ${data.environmentFallback.account}`
              : ", which Stripe would not name"}
            . That is where money taken here would go.
          </p>
          <p className="mt-1 text-sm" style={muted}>
            {/*
              This is the whole point of the card. An instance charged into
              another company's Stripe account for weeks because the fallback
              was silent and no screen named the account it pointed at.
            */}
            Connect the account you mean to use below and it takes over. If the
            name above is the right business, there is nothing to do.
          </p>
        </Card>
      ) : null}

      <Connection
        provider="stripe"
        label="Stripe"
        webhookUrl={stripeWebhook}
        accounts={data?.accounts ?? []}
        onChanged={refresh}
      />
      <Connection
        provider="paypal"
        label="PayPal"
        webhookUrl={paypalWebhook}
        accounts={data?.accounts ?? []}
        onChanged={refresh}
      />
    </>
  );
}

function Connection({
  provider,
  label,
  webhookUrl,
  accounts,
  onChanged,
}: {
  provider: string;
  label: string;
  webhookUrl: string;
  accounts: PaymentAccountRow[];
  onChanged: () => void;
}) {
  /** Sandbox first. Somebody rehearsing must not be one press from live. */
  const [mode, setMode] = useState("test");
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const account = accounts.find(
    (a) => a.provider === provider && a.mode === mode,
  );
  const live = accounts.find((a) => a.provider === provider && a.enabled);
  const path = `/api/payments/accounts/${provider}/${mode}`;

  /**
   * Save, check, set up the webhook and switch on — one press.
   *
   * Three buttons in an unstated order is what this was, and every pair of
   * them had a half-done state that looks like a fault. Pasting a key and
   * being told a webhook secret was missing, while it sat unsaved in the box
   * above, is the one that actually happened.
   */
  const connect = useMutation({
    mutationFn: async () => {
      await api(path, {
        method: "PUT",
        body: JSON.stringify({
          publicKey: publicKey || undefined,
          secretKey: secretKey || undefined,
          webhookSecret: webhookSecret || undefined,
        }),
      });
      /*
       * Read whatever came back, succeeded or not.
       *
       * The stages are the whole point of this endpoint and they arrive in the
       * refusal too — an instance the processor cannot reach is a 409 carrying
       * the sentence "paste the signing secret by hand". Letting the helper
       * throw on it turned that into "Something went wrong. Try again.", which
       * is how a screen manages to be less use than the server behind it.
       */
      const res = await fetch(`${path}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as {
        steps?: { step: string; ok: boolean; detail?: string }[];
      };
      return { ok: res.ok, steps: body.steps ?? [] };
    },
    onSuccess: () => {
      // Never held in the browser longer than the request needs them.
      setSecretKey("");
      setWebhookSecret("");
      onChanged();
    },
  });

  const disable = useMutation({
    mutationFn: () => api("/api/payments/accounts/disable", { method: "POST" }),
    onSuccess: onChanged,
  });

  /**
   * Removing the keys, which "Stop using it" does not do.
   *
   * Disabling leaves the secret key and the webhook secret in the database.
   * That is right while a business is switching between sandbox and live, and
   * wrong when it has closed the account, changed processor, or handed the
   * instance to somebody else — and until now there was no way to do the
   * second from any screen. The route has always been there.
   */
  const forget = useMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    onSuccess: onChanged,
  });

  return (
    <Card>
      <SectionHeading
        trailing={
          <State
            ok={Boolean(live)}
            yes={live?.mode === "live" ? "taking payments" : "sandbox"}
            no="not connected"
          />
        }
      >
        {label}
      </SectionHeading>

      {/* Sandbox and live are the same control the kit already draws: the
          selected one is a primary button, the other a secondary. It was two
          hand-styled buttons carrying the primary's own background token. */}
      <Toolbar>
        {["test", "live"].map((option) => (
          <Button
            key={option}
            variant={mode === option ? "primary" : "secondary"}
            onClick={() => setMode(option)}
          >
            {option === "test" ? "Sandbox" : "Live"}
          </Button>
        ))}
      </Toolbar>

      {account ? (
        <p className="mt-2 text-sm" style={muted}>
          Key ending {account.secretHint ?? "—"}
          {account.accountLabel ? ` · ${account.accountLabel}` : ""}
          {account.hasWebhookSecret ? "" : " · no webhook secret yet"}
        </p>
      ) : (
        <p className="mt-2 text-sm" style={muted}>
          Nothing stored for this mode yet.
        </p>
      )}

      {account?.lastTestMessage ? (
        <p
          className="mt-1 text-sm"
          style={
            account.lastTestOk
              ? { color: "var(--text-success)" }
              : { color: "var(--text-danger)" }
          }
        >
          {account.lastTestMessage}
        </p>
      ) : null}

      <div className="mt-3 grid gap-(--gap-toolbar) sm:grid-cols-3">
        <Field label="Publishable key" hint="Not a secret.">
          <Input
            value={publicKey}
            placeholder={account?.publicKey ?? "pk_…"}
            onChange={(e) => setPublicKey(e.target.value)}
          />
        </Field>
        <Field label="Secret key" hint="Leave blank to keep the stored one.">
          <SecretInput
            value={secretKey}
            placeholder="sk_…"
            onChange={(e) => setSecretKey(e.target.value)}
          />
        </Field>
        <Field
          label="Webhook secret"
          hint="Usually blank — we set this up with the processor for you."
        >
          <SecretInput
            value={webhookSecret}
            placeholder="whsec_…"
            onChange={(e) => setWebhookSecret(e.target.value)}
          />
        </Field>
      </div>

      {connect.data && !connect.data.ok && !connect.data.steps.length ? (
        <Warning className="mt-3">
          The processor could not be connected.
        </Warning>
      ) : null}

      {connect.data?.steps?.length ? (
        /*
         * What happened, stage by stage.
         *
         * Connecting a processor fails in several different places and they
         * are not interchangeable: a wrong key is not an unreachable instance,
         * and neither is a webhook the processor refused. One flat "it did not
         * work" makes somebody re-paste a perfectly good key.
         */
        <ul className="mt-3 flex flex-col gap-(--gap-tight) text-sm">
          {connect.data.steps.map((step) => (
            <li
              key={step.step}
              style={{
                color: step.ok ? "var(--text-success)" : "var(--text-danger)",
              }}
            >
              {step.ok ? "\u2713" : "\u2717"} {step.step}
              {step.detail ? <span style={muted}> — {step.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <Toolbar className="mt-3">
        <Button
          onClick={() => connect.mutate()}
          disabled={connect.isPending || (!secretKey && !account?.secretHint)}
        >
          {connect.isPending
            ? "Connecting…"
            : account?.enabled
              ? "Reconnect"
              : "Connect"}
        </Button>
        {account?.enabled ? (
          <Button
            variant="secondary"
            onClick={() => disable.mutate()}
            disabled={disable.isPending}
          >
            Stop using it
          </Button>
        ) : null}
        {/*
          Only where there is something to forget, and never on the account
          currently taking money — that one is stopped first, deliberately, so
          removing the keys cannot be the thing that stops payments working.
        */}
        {account && !account.enabled ? (
          <Button
            variant="danger"
            onClick={() => forget.mutate()}
            disabled={forget.isPending}
          >
            Forget these keys
          </Button>
        ) : null}
      </Toolbar>

      {/*
        The failure that has to be visible.
        
        This button called a route the running server did not have yet, got a
        404, and showed nothing at all — because the only error notes on the
        screen belonged to mutations the button no longer used. "It does
        nothing" is the worst answer a button can give, and it was produced by
        an error that was being thrown and discarded.
      */}
      {connect.error ? <ErrorNote error={connect.error} /> : null}
      {disable.error ? <ErrorNote error={disable.error} /> : null}
      {forget.error ? <ErrorNote error={forget.error} /> : null}

      {/* Where the processor sends its events. Nothing is confirmed without
          it, so it is on the screen rather than in a document somewhere. */}
      <Copyable label="Webhook address" value={webhookUrl} />
    </Card>
  );
}

/**
 * What happens right after a key is saved.
 *
 * `POST /api/settings/license` only ever asks the host to go fetch a token
 * when an update agent is listening; without one, storing the key does
 * nothing else on its own. Before this note existed, the input just cleared
 * and the card sat exactly as it was — a business with no agent installed had
 * no way to learn that saving the key was not the whole job, only the answer
 * `sync.error` already gives, and only once a licence is already Pro (see the
 * button beneath this branch). Read straight from what `enterKey` itself was
 * told, since that is the one place that already knows.
 */
export function LicenseSyncNote({ syncing }: { syncing: boolean }) {
  return (
    <p className="mt-2 text-sm" style={muted}>
      {syncing
        ? "Key saved. Checking your subscription — this can take a minute; the Updates panel below will show progress."
        : "Key saved, but this instance has no update agent to fetch your licence automatically. Run `sentrello activate` on the server, then reload this page."}
    </p>
  );
}

/**
 * What this instance is licensed for, and what version it runs.
 *
 * Together because they are one question in practice: a licence decides which
 * releases an instance is offered, and a release that will not start is
 * usually a licence that has expired.
 */
export function SettingsLicence() {
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("/api/settings"),
  });
  const updates = useQuery({
    queryKey: ["updates"],
    queryFn: () => api<UpdatesResponse>("/api/settings/updates"),
    // While the host is working, the only way to see progress is to ask again.
    // Idle instances ask once and stop, so this is not a background poller.
    refetchInterval: (q) =>
      q.state.data &&
      ["requested", "running"].includes(q.state.data.status.state)
        ? 5_000
        : false,
  });
  const licence = useQuery({
    queryKey: ["license"],
    queryFn: () => api<LicenseResponse>("/api/license"),
    // Entering a key or pressing "check my subscription" only *asks* the host
    // to go fetch a token — the fetch itself finishes on the host's own time,
    // outside this request. Without this, the only way to see the result was
    // to reload the page: the Updates card above already polls while the host
    // is working, and this rides the same signal so the Licence card catches
    // up the moment that work is done, not only when somebody happens to know
    // to refresh.
    refetchInterval: () =>
      updates.data &&
      ["requested", "running"].includes(updates.data.status.state)
        ? 5_000
        : false,
  });

  const applyUpdate = useMutation({
    mutationFn: () => api("/api/settings/updates", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["updates"] }),
  });

  /**
   * A Free instance is told nothing until it is asked to look, so the answer
   * lives here rather than in the screen's own data. Once looked, it is
   * offered exactly the button a licensed instance gets.
   */
  const check = useMutation({
    mutationFn: () =>
      api<{ current: string; latest: string; updateAvailable: boolean }>(
        "/api/settings/updates/check",
        { method: "POST" },
      ),
  });

  // Asked for once before it happens. Going back is recoverable — running it
  // again rolls forward — but it does take the business offline for a minute,
  // which is not something to do on a mis-click.
  const [confirmRollback, setConfirmRollback] = useState(false);
  const rollback = useMutation({
    mutationFn: () => api("/api/settings/rollback", { method: "POST" }),
    onSuccess: () => {
      setConfirmRollback(false);
      qc.invalidateQueries({ queryKey: ["updates"] });
    },
  });

  const [keyInput, setKeyInput] = useState("");
  const enterKey = useMutation({
    mutationFn: () =>
      api<{ stored: true; syncing: boolean }>("/api/settings/license", {
        method: "POST",
        body: JSON.stringify({ key: keyInput }),
      }),
    onSuccess: () => {
      setKeyInput("");
      qc.invalidateQueries({ queryKey: ["license"] });
      qc.invalidateQueries({ queryKey: ["updates"] });
    },
  });

  const sync = useMutation({
    mutationFn: () => api("/api/settings/sync", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license"] });
      qc.invalidateQueries({ queryKey: ["updates"] });
    },
  });

  const latest = check.data?.latest ?? updates.data?.latest ?? null;
  const updateAvailable =
    check.data?.updateAvailable ?? updates.data?.updateAvailable ?? false;

  const data = settings.data;

  return (
    <Page width="prose">
      {licence.data?.failedBundles?.length ? (
        // Paid features vanishing without explanation is the worst way to
        // find out about this, so it goes at the top and stays red.
        <Card>
          <Warning className="font-medium">A paid module did not start</Warning>
          {licence.data.failedBundles.map((f) => (
            <p key={f.name} className="mt-1 text-sm">
              <strong>{f.name}</strong> — {f.reason}
            </p>
          ))}
          <p className="mt-2 text-sm" style={muted}>
            Everything that module provides is unavailable until this is fixed.
            Reinstalling it with <code>sentrello update</code> is the usual
            remedy; if it persists, the release is at fault rather than your
            instance.
          </p>
        </Card>
      ) : null}

      <Card>
        <SectionHeading
          trailing={
            licence.data ? (
              <State
                // No token at all is not a failure: the instance is simply
                // Free, which is a tier and not a warning.
                ok={licence.data.valid || !licence.data.tokenPresent}
                yes={
                  licence.data.valid && licence.data.tier === "pro"
                    ? "Pro"
                    : "Free"
                }
                no="not verified"
              />
            ) : null
          }
        >
          Licence
        </SectionHeading>
        {/*
          A failed fetch says so, rather than drawing an empty card.

          Every sentence that would name a tier sits inside the guard below,
          so this was never going to state something false — but an empty
          card is indistinguishable from one still loading, and a Pro
          customer whose licence call fails also loses the "Check my
          subscription" button that would fix it. A dead end is its own kind
          of wrong answer.
        */}
        {licence.error ? (
          <>
            <ErrorNote error={licence.error} />
            <div className="mt-(--gap-toolbar)">
              <button
                type="button"
                onClick={() => licence.refetch()}
                disabled={licence.isFetching}
                className="text-sm link-muted"
              >
                {licence.isFetching ? "Asking again…" : "Try again"}
              </button>
            </div>
          </>
        ) : null}
        {licence.data ? (
          <>
            {!licence.data.valid && licence.data.tokenPresent ? (
              // The answer to "why did my features disappear?" — a licence is
              // installed and not verifying. A fresh Free instance never sees
              // this: with no token there is nothing to warn about.
              <p
                className="mt-1 text-sm"
                style={{ color: "var(--text-warning)" }}
              >
                Running as Free
                {(() => {
                  const friendly = friendlyLicenseReason(licence.data.reason);
                  return friendly ? `: ${friendly}.` : ".";
                })()} Paid features stay dark until a valid licence is in place.
                Your data is untouched and returns when it is.
              </p>
            ) : null}

            {/*
              Upgrading from Free. Without this, buying Pro means SSH into your
              own server and editing a dotfile at the moment you hand over
              money — so the purchase ends in a support ticket rather than a
              working instance.
            */}
            {!licence.data.valid || licence.data.tier !== "pro" ? (
              <div className="mt-3 border-t pt-3 border-line">
                <Field
                  label="Licence key"
                  hint="From the email you were sent after buying. Paid features appear once it is checked."
                >
                  <Input
                    value={keyInput}
                    placeholder="SENT-XXXX-XXXX-XXXX-XXXX"
                    onChange={(e) => setKeyInput(e.target.value)}
                  />
                </Field>
                <div className="mt-2">
                  <Button
                    onClick={() => enterKey.mutate()}
                    disabled={enterKey.isPending || keyInput.trim().length < 24}
                  >
                    {enterKey.isPending ? "Checking…" : "Activate"}
                  </Button>
                </div>
                {enterKey.error ? <ErrorNote error={enterKey.error} /> : null}
                {enterKey.data ? (
                  <LicenseSyncNote syncing={enterKey.data.syncing} />
                ) : null}
              </div>
            ) : (
              // Bought a module on the website a minute ago? This is what makes
              // it appear now rather than whenever the daily refresh runs.
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => sync.mutate()}
                  disabled={sync.isPending}
                  className="text-sm link-muted"
                >
                  {sync.isPending
                    ? "Checking your subscription…"
                    : "Check my subscription for changes"}
                </button>
                {sync.error ? <ErrorNote error={sync.error} /> : null}
              </div>
            )}

            {licence.data.modules.length > 0 ? (
              <p className="mt-1 text-sm" style={muted}>
                Modules: {licence.data.modules.join(", ")}
              </p>
            ) : null}

            {licence.data.tokenExpiresAt ? (
              <p className="mt-1 text-sm" style={muted}>
                Licence token renews automatically; this one is valid until{" "}
                {new Date(licence.data.tokenExpiresAt).toLocaleString()}. A
                renewal that cannot reach the licence server is not urgent —
                there is a grace period before anything changes.
              </p>
            ) : null}

            {licence.data.graceUntil ? (
              <p
                className="mt-1 text-sm"
                style={{ color: "var(--text-warning)" }}
              >
                Billing needs attention. Paid features keep working until{" "}
                {new Date(licence.data.graceUntil).toLocaleDateString()}.
              </p>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card>
        <SectionHeading
          trailing={
            /*
              An instance that has not looked is not "up to date" — it does not
              know. Saying so is the difference between a badge and a guess.
            */
            latest === null ? (
              <span className="text-sm font-medium" style={muted}>
                not checked
              </span>
            ) : (
              <State
                ok={!updateAvailable}
                yes="up to date"
                no="update available"
              />
            )
          }
        >
          Updates
        </SectionHeading>

        <p className="text-sm" style={muted}>
          Running version {updates.data?.current ?? "…"}.
        </p>

        {/*
          An update replaces the running container, so the app cannot do it
          itself. Where the host has no agent to do it, saying so beats a
          button that appears to work and silently does nothing.
        */}
        {updates.data?.managedExternally ? (
          <p className="mt-1 text-sm" style={muted}>
            This instance's version is set by its deploy rather than from here.
            Updating it from this screen would replace the image it runs, so the
            button is deliberately absent.
          </p>
        ) : updateAvailable ? (
          updates.data?.canApply ? (
            <>
              <p className="mt-1 text-sm">
                Version {latest} is available. Updating takes about a minute,
                during which the app is unavailable. Your data is not touched.
              </p>
              <p className="mt-1 text-sm" style={muted}>
                {/* Said plainly, because the fear is that it happens to you. */}
                Nothing updates on its own — this instance stays on{" "}
                {updates.data.current} until you press it.
              </p>
              <div className="mt-2">
                <Button
                  onClick={() => applyUpdate.mutate()}
                  disabled={
                    applyUpdate.isPending ||
                    ["requested", "running"].includes(updates.data.status.state)
                  }
                >
                  {["requested", "running"].includes(updates.data.status.state)
                    ? "Updating…"
                    : `Update to ${latest}`}
                </Button>
              </div>
            </>
          ) : (
            <p className="mt-1 text-sm">
              Version {latest} is available. This instance cannot update itself,
              so run <code>sentrello update</code> on the server.
            </p>
          )
        ) : latest !== null ? null : updates.data?.canCheck ? (
          /*
            The Free path. Nothing has been asked of anyone yet: this instance
            holds no licence to identify itself with, and it does not contact
            us until somebody presses this. What comes back is a version
            number and nothing else.
          */
          <>
            <p className="mt-1 text-sm" style={muted}>
              This instance does not check for updates by itself. Look now, and
              it will tell you whether a newer version exists — you decide when
              to apply it.
            </p>
            <div className="mt-2">
              <Button
                variant="secondary"
                onClick={() => check.mutate()}
                disabled={check.isPending}
              >
                {check.isPending ? "Checking…" : "Check for updates"}
              </Button>
            </div>
            {check.error ? <ErrorNote error={check.error} /> : null}
          </>
        ) : null}

        {/* Looked, and there was nothing. Worth saying once. */}
        {latest !== null && !updateAvailable && check.data ? (
          <p className="mt-1 text-sm" style={muted}>
            Version {latest} is the newest release, and this instance is on it.
          </p>
        ) : null}

        {/*
          Kept quieter than the update above it, and only shown when there is
          somewhere to go back to. It is the thing you want at 2am after a bad
          update, not something to invite on an ordinary Tuesday.
        */}
        {updates.data?.rollbackTo && updates.data.canApply ? (
          <div className="mt-3 border-t pt-3 border-line">
            {confirmRollback ? (
              <>
                <p className="text-sm">
                  Go back to {updates.data.rollbackTo}? The app restarts and is
                  unavailable for a minute or two.
                </p>
                <p className="mt-1 text-sm" style={muted}>
                  {/* The question everyone actually has, answered before it is asked. */}
                  Your data is not changed — nothing entered since the update is
                  lost. If you need the database put back as well, that is a
                  separate step on the server.
                </p>
                <Toolbar className="mt-2">
                  <Button
                    onClick={() => rollback.mutate()}
                    disabled={rollback.isPending}
                  >
                    {rollback.isPending
                      ? "Going back…"
                      : `Go back to ${updates.data.rollbackTo}`}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setConfirmRollback(false)}
                  >
                    Cancel
                  </Button>
                </Toolbar>
              </>
            ) : (
              <p className="text-sm" style={muted}>
                Something wrong after updating?{" "}
                <button
                  type="button"
                  onClick={() => setConfirmRollback(true)}
                  className="link"
                  disabled={["requested", "running"].includes(
                    updates.data.status.state,
                  )}
                >
                  Go back to {updates.data.rollbackTo}
                </button>
              </p>
            )}
            {rollback.error ? <ErrorNote error={rollback.error} /> : null}
          </div>
        ) : null}

        {updates.data && updates.data.status.state !== "idle" ? (
          <p
            className="mt-2 text-sm"
            style={
              updates.data.status.state === "failed"
                ? { color: "var(--text-danger)" }
                : muted
            }
          >
            {updates.data.status.message ?? updates.data.status.state}
          </p>
        ) : null}

        {applyUpdate.error ? <ErrorNote error={applyUpdate.error} /> : null}

        {updates.data && !updates.data.canCheck && latest === null ? (
          <p className="mt-1 text-sm" style={muted}>
            This instance has nowhere to check with, so it cannot tell you
            whether a newer version exists. Releases are published on GitHub.
          </p>
        ) : null}
      </Card>

      {data ? <Telemetry telemetry={data.telemetry} /> : null}
    </Page>
  );
}

/** What the licence includes, and which of it this business has set up. */
export function SettingsModules() {
  return (
    <Page width="prose">
      <Modules />
    </Page>
  );
}

/**
 * The usage report, and the ability to change your mind about it.
 *
 * Says exactly what is sent, because a claim that something is anonymous is
 * worth nothing next to a list somebody can read. Opt-in at install; this is
 * where it goes off again without editing a dotfile on your own server.
 */
function Telemetry({
  telemetry,
}: {
  telemetry: { enabled: boolean; fixedOnServer: boolean };
}) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api("/api/settings/telemetry", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <Card>
      <SectionHeading>Usage reporting</SectionHeading>
      <p className="text-sm" style={muted}>
        Once a day, if you allow it, this instance sends: the version it runs,
        whether it is Free or Pro, which modules are loaded, and a band for how
        many people use it (1, 2–5, 6–10, 11–20, 21+). Nothing else — no
        customer records, no names, no figures, no business identifier.
      </p>
      <Toolbar className="mt-2">
        <State ok={telemetry.enabled} yes="sending" no="not sending anything" />
        {telemetry.fixedOnServer ? (
          <span className="text-sm" style={muted}>
            Set on the server, so it cannot be changed here.
          </span>
        ) : (
          <Button
            variant="secondary"
            onClick={() => toggle.mutate(!telemetry.enabled)}
            disabled={toggle.isPending}
          >
            {telemetry.enabled ? "Stop sending" : "Start sending"}
          </Button>
        )}
      </Toolbar>
      {toggle.error ? <ErrorNote error={toggle.error} /> : null}
    </Card>
  );
}

/**
 * What this licence includes, and what has actually been set up.
 *
 * Owning a module and using it are different things. Somebody buys Pro with
 * four modules and configures two; the other two are theirs, paid for, and
 * belong here waiting rather than in the sidebar as screens nobody has filled
 * in. Turning one off later hides it and deletes nothing — a diary switched
 * off in the winter is still there in the spring.
 */
function Modules() {
  const qc = useQueryClient();
  const meta = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/api/_meta"),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api(`/api/modules/${input.id}`, {
        method: "POST",
        body: JSON.stringify({ enabled: input.enabled }),
      }),
    // Everything: the sidebar is built from the same call.
    onSuccess: () => qc.invalidateQueries(),
  });

  if (meta.isLoading) return null;

  // The server says which modules are optional and how each stands. The
  // browser working that out from the nav would get it wrong the first time a
  // Free module was renamed.
  const modules = meta.data?.modules ?? [];
  if (modules.length === 0) return null;

  const available = modules.filter((m) => !m.enabled);
  const switchable = modules.filter((m) => m.enabled);

  return (
    <Card>
      <SectionHeading>Modules</SectionHeading>
      <p className="text-sm" style={muted}>
        What your licence includes. Set one up when you are ready for it —
        nothing is lost by leaving it until then.
      </p>

      <ul className="mt-3 flex flex-col gap-(--gap-toolbar)">
        {available.map((m) => (
          <li
            key={m.id}
            className="flex flex-wrap items-center justify-between gap-(--gap-toolbar) border-t pt-2 text-sm border-line"
          >
            <div>
              <div>{m.label}</div>
              <div className="text-xs" style={muted}>
                Included, not set up yet
              </div>
            </div>
            <Button
              variant="secondary"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ id: m.id, enabled: true })}
            >
              Set up
            </Button>
          </li>
        ))}

        {switchable.map((n) => (
          <li
            key={n.id}
            className="flex flex-wrap items-center justify-between gap-(--gap-toolbar) border-t pt-2 text-sm border-line"
          >
            <div>
              <div>{n.label}</div>
              <div className="text-xs" style={muted}>
                In use
              </div>
            </div>
            <button
              type="button"
              className="text-xs link-muted"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ id: n.id, enabled: false })}
            >
              Put away
            </button>
          </li>
        ))}
      </ul>
      {toggle.error ? <ErrorNote error={toggle.error} /> : null}
    </Card>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Meta, api } from "../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  muted,
} from "../lib/ui";

interface LicenseResponse {
  tier: string;
  valid: boolean;
  reason: string | null;
  modules: string[];
  seats: number | null;
  instanceId: string | null;
  tokenExpiresAt: string | null;
  graceUntil: string | null;
  modulesLoaded: string[];
  failedBundles: { name: string; reason: string }[];
}

interface SettingsResponse {
  business: {
    name: string;
    slug: string;
    address: string;
    taxId: string;
    taxIdLabel: string;
    paymentInstructions: string;
  };
  instance: { baseUrl: string; baseUrlMatchesRequest: boolean };
  telemetry: { enabled: boolean; fixedOnServer: boolean };
  email: { configured: boolean; from: string | null };
  payments: {
    stripe: {
      configured: boolean;
      webhookConfigured: boolean;
      testMode: boolean;
      invoiceWebhookUrl: string;
      shopWebhookUrl: string;
    };
    paypal: {
      configured: boolean;
      webhookConfigured: boolean;
      environment: string;
      shopWebhookUrl: string;
    };
  };
}

/** Green when it is set up, amber when it is not — never a bare boolean. */
function State({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span
      className="text-sm font-medium"
      style={{ color: ok ? "var(--color-success)" : "var(--color-warning)" }}
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
        className="w-full break-all rounded border px-2 py-1 text-left text-xs"
        style={{ borderColor: "var(--border)" }}
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
  const [details, setDetails] = useState<Record<string, string> | null>(null);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("/api/settings"),
  });
  const licence = useQuery({
    queryKey: ["license"],
    queryFn: () => api<LicenseResponse>("/api/license"),
  });

  const rename = useMutation({
    mutationFn: (body: Record<string, string>) =>
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
  };
  const form = details ?? saved;
  const patch = (change: Record<string, string>) =>
    setDetails({ ...form, ...change });
  const dirty =
    (name !== null && name !== data.business.name) ||
    (Object.keys(saved) as (keyof typeof saved)[]).some(
      (k) => form[k] !== saved[k],
    );

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <p className="mb-3 font-medium">Your business</p>
        <div className="space-y-3">
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
            <textarea
              rows={3}
              value={form.address}
              onChange={(e) => patch({ address: e.target.value })}
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{
                background: "var(--surface-raised)",
                borderColor: "var(--border)",
                color: "var(--text)",
              }}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
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

          <Field
            label="How to pay"
            hint="Bank details or instructions, shown on the customer's page."
          >
            <textarea
              rows={3}
              value={form.paymentInstructions}
              onChange={(e) => patch({ paymentInstructions: e.target.value })}
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{
                background: "var(--surface-raised)",
                borderColor: "var(--border)",
                color: "var(--text)",
              }}
            />
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

      <Card>
        <p className="font-medium">This instance</p>
        <p className="mt-1 text-sm" style={muted}>
          Links in emails are built from {data.instance.baseUrl}.
        </p>
        {licence.data?.instanceId ? (
          <p className="mt-1 text-xs" style={muted}>
            Instance {licence.data.instanceId}
          </p>
        ) : null}
        {!data.instance.baseUrlMatchesRequest ? (
          // The reason a customer receives a link pointing at localhost.
          <p className="mt-1 text-sm" style={{ color: "var(--color-warning)" }}>
            That does not match the address you are using right now. Links sent
            to customers may not work until the server's configured address is
            corrected.
          </p>
        ) : null}
      </Card>
    </div>
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
    <div className="max-w-3xl space-y-4">
      <Card>
        <div className="flex items-baseline justify-between">
          <p className="font-medium">Email</p>
          <State ok={data.email.configured} yes="working" no="not set up" />
        </div>
        <p className="mt-1 text-sm" style={muted}>
          {data.email.configured
            ? `Sent from ${data.email.from ?? "the configured address"}.`
            : "Invoices, receipts and password resets cannot be delivered until an email provider is configured on the server. Overdue invoices are not chased either — they are left alone rather than marked as chased, so nothing is lost by setting this up later."}
        </p>
      </Card>

      <PaymentConnections
        stripeWebhook={data.payments.stripe.invoiceWebhookUrl}
        paypalWebhook={data.payments.paypal.shopWebhookUrl}
      />
    </div>
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
          <p className="font-medium" style={{ color: "var(--color-warning)" }}>
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
          <p className="font-medium" style={{ color: "var(--color-warning)" }}>
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

  const save = useMutation({
    mutationFn: () =>
      api(path, {
        method: "PUT",
        body: JSON.stringify({
          publicKey: publicKey || undefined,
          secretKey: secretKey || undefined,
          webhookSecret: webhookSecret || undefined,
        }),
      }),
    onSuccess: () => {
      // Never held in the browser longer than the request needs them.
      setSecretKey("");
      setWebhookSecret("");
      onChanged();
    },
  });

  const test = useMutation({
    mutationFn: () => api(`${path}/test`, { method: "POST" }),
    onSuccess: onChanged,
  });
  const enable = useMutation({
    mutationFn: () => api(`${path}/enable`, { method: "POST" }),
    onSuccess: onChanged,
  });
  const disable = useMutation({
    mutationFn: () => api("/api/payments/accounts/disable", { method: "POST" }),
    onSuccess: onChanged,
  });

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{label}</p>
        <State
          ok={Boolean(live)}
          yes={live?.mode === "live" ? "taking payments" : "sandbox"}
          no="not connected"
        />
      </div>

      <div className="mt-2 flex gap-2 text-sm">
        {["test", "live"].map((option) => (
          <button
            key={option}
            type="button"
            className="rounded-md px-3 py-1"
            style={
              mode === option
                ? {
                    background: "var(--color-brand-500)",
                    color: "var(--color-neutral-50)",
                  }
                : { ...muted }
            }
            onClick={() => setMode(option)}
          >
            {option === "test" ? "Sandbox" : "Live"}
          </button>
        ))}
      </div>

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
              ? { color: "var(--color-success)" }
              : { color: "var(--color-danger)" }
          }
        >
          {account.lastTestMessage}
        </p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Publishable key" hint="Not a secret.">
          <Input
            value={publicKey}
            placeholder={account?.publicKey ?? "pk_…"}
            onChange={(e) => setPublicKey(e.target.value)}
          />
        </Field>
        <Field label="Secret key" hint="Leave blank to keep the stored one.">
          <Input
            type="password"
            value={secretKey}
            placeholder="sk_…"
            onChange={(e) => setSecretKey(e.target.value)}
          />
        </Field>
        <Field
          label="Webhook secret"
          hint="Without it, payments are never confirmed."
        >
          <Input
            type="password"
            value={webhookSecret}
            placeholder="whsec_…"
            onChange={(e) => setWebhookSecret(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          Save keys
        </Button>
        <Button
          variant="secondary"
          onClick={() => test.mutate()}
          disabled={!account || test.isPending}
        >
          {test.isPending ? "Asking…" : "Test connection"}
        </Button>
        {account?.enabled ? (
          <Button
            variant="secondary"
            onClick={() => disable.mutate()}
            disabled={disable.isPending}
          >
            Stop using it
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => enable.mutate()}
            disabled={!account?.lastTestOk || enable.isPending}
          >
            Use this one
          </Button>
        )}
      </div>

      {save.error ? <ErrorNote error={save.error} /> : null}
      {enable.error ? <ErrorNote error={enable.error} /> : null}

      {/* Where the processor sends its events. Nothing is confirmed without
          it, so it is on the screen rather than in a document somewhere. */}
      <Copyable label="Webhook address" value={webhookUrl} />
    </Card>
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
  const licence = useQuery({
    queryKey: ["license"],
    queryFn: () => api<LicenseResponse>("/api/license"),
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
      api("/api/settings/license", {
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
    <div className="max-w-3xl space-y-4">
      {licence.data?.failedBundles?.length ? (
        // Paid features vanishing without explanation is the worst way to
        // find out about this, so it goes at the top and stays red.
        <Card>
          <p className="font-medium" style={{ color: "var(--color-danger)" }}>
            A paid module did not start
          </p>
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
        <div className="flex items-baseline justify-between">
          <p className="font-medium">Licence</p>
          {licence.data ? (
            <State
              ok={licence.data.valid}
              yes={licence.data.tier === "pro" ? "Pro" : "Free"}
              no="not verified"
            />
          ) : null}
        </div>
        {licence.data ? (
          <>
            {!licence.data.valid ? (
              // The answer to "why did my features disappear?"
              <p
                className="mt-1 text-sm"
                style={{ color: "var(--color-warning)" }}
              >
                Running as Free
                {licence.data.reason ? `: ${licence.data.reason}` : "."} Paid
                features stay dark until a valid licence is in place. Your data
                is untouched and returns when it is.
              </p>
            ) : null}

            {/*
              Upgrading from Free. Without this, buying Pro means SSH into your
              own server and editing a dotfile at the moment you hand over
              money — so the purchase ends in a support ticket rather than a
              working instance.
            */}
            {!licence.data.valid || licence.data.tier !== "pro" ? (
              <div
                className="mt-3 border-t pt-3"
                style={{ borderColor: "var(--border)" }}
              >
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
                style={{ color: "var(--color-warning)" }}
              >
                Billing needs attention. Paid features keep working until{" "}
                {new Date(licence.data.graceUntil).toLocaleDateString()}.
              </p>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card>
        <div className="flex items-baseline justify-between">
          <p className="font-medium">Updates</p>
          {/*
            An instance that has not looked is not "up to date" — it does not
            know. Saying so is the difference between a badge and a guess.
          */}
          {latest === null ? (
            <span className="text-sm font-medium" style={muted}>
              not checked
            </span>
          ) : (
            <State
              ok={!updateAvailable}
              yes="up to date"
              no="update available"
            />
          )}
        </div>

        <p className="mt-1 text-sm" style={muted}>
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
          <div
            className="mt-3 border-t pt-3"
            style={{ borderColor: "var(--border)" }}
          >
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
                <div className="mt-2 flex gap-2">
                  <Button
                    onClick={() => rollback.mutate()}
                    disabled={rollback.isPending}
                  >
                    {rollback.isPending
                      ? "Going back…"
                      : `Go back to ${updates.data.rollbackTo}`}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setConfirmRollback(false)}
                    className="text-sm link-muted"
                  >
                    Cancel
                  </button>
                </div>
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
                ? { color: "var(--color-danger)" }
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
    </div>
  );
}

/** What the licence includes, and which of it this business has set up. */
export function SettingsModules() {
  return (
    <div className="max-w-3xl space-y-4">
      <Modules />
    </div>
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
      <p className="font-medium">Usage reporting</p>
      <p className="mt-1 text-sm" style={muted}>
        Once a day, if you allow it, this instance sends: the version it runs,
        whether it is Free or Pro, which modules are loaded, and a band for how
        many people use it (1, 2–5, 6–10, 11–20, 21+). Nothing else — no
        customer records, no names, no figures, no business identifier.
      </p>
      <div className="mt-2 flex items-center gap-3">
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
      </div>
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
      <p className="font-medium">Modules</p>
      <p className="mt-1 text-sm" style={muted}>
        What your licence includes. Set one up when you are ready for it —
        nothing is lost by leaving it until then.
      </p>

      <ul className="mt-3 space-y-2">
        {available.map((m) => (
          <li
            key={m.id}
            className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm"
            style={{ borderColor: "var(--border)" }}
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
            className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm"
            style={{ borderColor: "var(--border)" }}
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

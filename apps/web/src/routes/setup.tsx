import { type FormEvent, useState } from "react";
import { api } from "../lib/api";

/**
 * First run: claim the instance. Shown only while no organization exists, and
 * the endpoint behind it refuses once one does — this must never become a
 * second way in.
 */
export function Setup({
  onDone,
  tokenRequired,
}: {
  onDone: () => void;
  tokenRequired: boolean;
}) {
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError("Use at least 12 characters.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          password,
          organizationName,
          setupToken,
        }),
      });
      onDone();
    } catch {
      setError(
        tokenRequired
          ? "Setup failed. Check the setup token from the server's .env file."
          : "Could not complete setup. It may already have been done.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded border p-6"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-raised)",
        }}
      >
        <div>
          <h1 className="text-lg font-semibold">Set up Sentrello</h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Create the owner account for this instance. Do this now — until it
            is done, anyone who can reach this page could claim it.
          </p>
        </div>

        <Field
          label="Your name"
          value={name}
          onChange={setName}
          autoComplete="name"
        />
        <Field
          label="Business name"
          value={organizationName}
          onChange={setOrganizationName}
          required={false}
          autoComplete="organization"
        />
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 12 characters."
        />

        {tokenRequired ? (
          <Field
            label="Setup token"
            value={setupToken}
            onChange={setSetupToken}
            hint="SENTRELLO_SETUP_TOKEN from this server's .env file."
          />
        ) : null}

        {error ? (
          <p className="text-sm" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded px-3 py-2 text-sm font-medium"
          style={{
            background: "var(--color-brand-500)",
            color: "var(--color-neutral-50)",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Setting up…" : "Create owner account"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = true,
  autoComplete,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <input
        type={type}
        required={required}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border px-2 py-1"
        style={{ borderColor: "var(--border)" }}
      />
      {hint ? (
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

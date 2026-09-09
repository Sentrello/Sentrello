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
  /**
   * The account is made, and now we ask the two questions that decide what
   * compliance this business carries.
   *
   * A second step rather than a longer first one. Somebody claiming an instance
   * wants an account; asked about data protection in the same breath they will
   * pick anything to get past it. And it has to be after the account exists,
   * because the answer is stored against the business.
   */
  const [placed, setPlaced] = useState(false);
  const [places, setPlaces] = useState<string[]>([]);
  const [sectors, setSectors] = useState<string[]>([]);
  const [offered, setOffered] = useState<
    { id: string; label: string; when: string; suggested: boolean }[]
  >([]);
  const [picked, setPicked] = useState<string[]>([]);

  const tick = (
    list: string[],
    set: (v: string[]) => void,
    value: string,
    on: boolean,
  ) => set(on ? [...list, value] : list.filter((x) => x !== value));

  async function suggest() {
    setBusy(true);
    try {
      const res = await api<{
        suggested: { id: string; label: string; when: string }[];
        notSuggested: { id: string; label: string; when: string }[];
      }>("/api/compliance/suggest", {
        method: "POST",
        body: JSON.stringify({ places, sectors }),
      });
      setOffered([
        ...res.suggested.map((r) => ({ ...r, suggested: true })),
        ...res.notSuggested.map((r) => ({ ...r, suggested: false })),
      ]);
      // Suggested ones start ticked; the business unticks what does not apply.
      setPicked(res.suggested.map((r) => r.id));
      setPlaced(true);
    } catch {
      // Not being able to suggest must not block finishing setup. The screen
      // in Settings offers the same choices, and an instance nobody can finish
      // installing is a worse outcome than a business that picks later.
      onDone();
    } finally {
      setBusy(false);
    }
  }

  async function saveRegimes() {
    setBusy(true);
    try {
      await api("/api/compliance", {
        method: "PUT",
        body: JSON.stringify({ regimes: picked }),
      });
    } catch {
      // Same reasoning as above.
    } finally {
      setBusy(false);
      onDone();
    }
  }

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
      await suggest();
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

  if (placed) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div
          className="w-full max-w-md space-y-4 rounded border p-6"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-raised)",
          }}
        >
          <div>
            <h1 className="text-lg font-semibold">What applies to you</h1>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Compliance works like modules here — switch on what applies to
              your business. We have ticked what your answers suggest. Change
              any of it now or later; none of it is a one-way door.
            </p>
          </div>

          {offered.map((r) => (
            <label key={r.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.includes(r.id)}
                onChange={(e) =>
                  tick(picked, setPicked, r.id, e.currentTarget.checked)
                }
              />
              <span>
                {r.label}
                {r.suggested ? null : (
                  <span
                    className="ml-1 text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    (not suggested)
                  </span>
                )}
                <span className="block" style={{ color: "var(--text-muted)" }}>
                  {r.when}
                </span>
              </span>
            </label>
          ))}

          <button
            type="button"
            disabled={busy}
            onClick={saveRegimes}
            className="w-full rounded px-3 py-2 text-sm font-medium"
            style={{ background: "var(--accent)", color: "white" }}
          >
            {busy ? "Saving…" : "Finish"}
          </button>
        </div>
      </div>
    );
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

        {/*
          Two questions, both answerable without looking anything up. They
          decide what compliance this business carries, and getting them wrong
          costs nothing — everything here can be changed afterwards.
        */}
        <fieldset>
          <legend className="text-sm font-medium">Where do you operate?</legend>
          {[
            ["us", "United States"],
            ["us-ca", "California"],
            ["eu", "European Union"],
            ["uk", "United Kingdom"],
            ["ca", "Canada"],
          ].map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={places.includes(id as string)}
                onChange={(e) =>
                  tick(places, setPlaces, id as string, e.currentTarget.checked)
                }
              />
              {label}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium">
            Does any of this describe you?
          </legend>
          {[
            ["health", "We handle health or patient information"],
            ["government", "We sell to government or public bodies"],
            ["enterprise", "Large customers send us security questionnaires"],
          ].map(([id, label]) => (
            <label key={id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={sectors.includes(id as string)}
                onChange={(e) =>
                  tick(
                    sectors,
                    setSectors,
                    id as string,
                    e.currentTarget.checked,
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
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
            background: "var(--brand-on-white-text)",
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

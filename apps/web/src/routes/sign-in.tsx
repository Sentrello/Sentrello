import { type FormEvent, useState } from "react";
import { authClient } from "../lib/auth";
import { ForgotPassword } from "./forgot-password";

export function SignIn() {
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when the password was right and an authenticator code is still owed.
  const [needsCode, setNeedsCode] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    /**
     * Businesses whose email is somewhere else sign in there instead.
     *
     * Asked before the password is sent rather than after it fails: somebody
     * at a firm on Google Workspace has no password here, and being told
     * "wrong password" for one they never set is the worst possible answer.
     * The check says only yes or no — never which provider, or whose.
     */
    const viaProvider = await fetch("/api/users/sso/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })
      .then((r) => (r.ok ? r.json() : { sso: false }))
      .catch(() => ({ sso: false }));

    if ((viaProvider as { sso?: boolean }).sso) {
      const { error: ssoError } = await authClient.signIn.sso({
        email,
        callbackURL: window.location.origin,
      });
      setBusy(false);
      if (ssoError) {
        setError(ssoError.message ?? "Could not reach your sign-in provider");
      }
      return;
    }

    const { data, error } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Could not sign in");
      return;
    }
    // Asked for in place rather than on a page of its own: there are no pages
    // here, and somebody halfway through signing in should not appear to have
    // been sent somewhere else.
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setNeedsCode(true);
    }
  }

  if (forgot) return <ForgotPassword onBack={() => setForgot(false)} />;
  if (needsCode) {
    return (
      <TwoFactorPrompt
        onCancel={() => {
          setNeedsCode(false);
          setPassword("");
        }}
      />
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
        <h1 className="text-lg font-semibold">Sign in to Sentrello</h1>

        <label className="block space-y-1 text-sm">
          <span>Email</span>
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border px-2 py-1"
            style={{ borderColor: "var(--border)" }}
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span>Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border px-2 py-1"
            style={{ borderColor: "var(--border)" }}
          />
        </label>

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
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <button
          type="button"
          onClick={() => setForgot(true)}
          className="w-full text-sm link-muted"
        >
          Forgot your password?
        </button>
      </form>
    </div>
  );
}

/**
 * The second factor, asked for once the password was right.
 *
 * A backup code is accepted in the same box. Somebody whose phone is in a
 * river is exactly the person who cannot find a second link to click, and the
 * two codes are different enough lengths to tell apart without asking.
 */
function TwoFactorPrompt({ onCancel }: { onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const trimmed = code.trim();
    const { error } =
      trimmed.length > 6
        ? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
        : await authClient.twoFactor.verifyTotp({
            code: trimmed,
            trustDevice: trust,
          });
    setBusy(false);
    if (error) setError(error.message ?? "That code was not accepted");
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
        <h1 className="text-lg font-semibold">Enter your code</h1>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          From your authenticator app, or one of your backup codes.
        </p>

        <label className="block space-y-1 text-sm">
          <span>Code</span>
          <input
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded border px-2 py-1"
            style={{ borderColor: "var(--border)" }}
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={trust}
            onChange={(e) => setTrust(e.target.checked)}
          />
          Do not ask on this device for 30 days
        </label>

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
          {busy ? "Checking…" : "Continue"}
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="w-full text-sm link-muted"
        >
          Start again
        </button>
      </form>
    </div>
  );
}

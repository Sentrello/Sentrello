import { type FormEvent, useEffect, useState } from "react";
import { authClient } from "../lib/auth";
import { PageCredit } from "../lib/credit";

/**
 * Getting back in without a password.
 *
 * On a self-hosted instance the owner is usually the only administrator, so a
 * forgotten password meant editing the database — there was nobody to ask.
 *
 * Two paths, because an instance may have no mail configured at all: with mail
 * this sends a link, and without it says so plainly and gives the command to
 * run on the host. Telling someone to check an inbox nothing will arrive in is
 * worse than telling them there is no email.
 */
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mailConfigured, setMailConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/_signin")
      .then((r) => r.json())
      .then((d: { mailConfigured: boolean }) =>
        setMailConfigured(d.mailConfigured),
      )
      .catch(() => setMailConfigured(false));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    // Shown whether or not the address exists: saying "no such account" turns
    // this form into a way to find out who has one.
    if (error && error.status !== 404) {
      setError(error.message ?? "Could not send the email");
      return;
    }
    setSent(true);
  }

  const box = {
    borderColor: "var(--border)",
    background: "var(--surface-raised)",
  };

  if (mailConfigured === false) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="space-y-4 rounded border p-6" style={box}>
            <h1 className="text-lg font-semibold">No email on this instance</h1>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              This Sentrello has no mail configured, so it cannot send you a
              reset link. On the machine running it:
            </p>
            <pre
              className="overflow-x-auto rounded border p-2 text-xs"
              style={{ borderColor: "var(--border)" }}
            >
              <code>sentrello reset-password {email || "you@example.com"}</code>
            </pre>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Configure email in Settings afterwards and this page will send a
              link instead.
            </p>
            <button type="button" onClick={onBack} className="text-sm link">
              Back to sign in
            </button>
          </div>
          <PageCredit />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded border p-6"
          style={box}
        >
          <h1 className="text-lg font-semibold">Reset your password</h1>

          {sent ? (
            <>
              <p className="text-sm">
                If an account exists for <strong>{email}</strong>, a link is on
                its way. It works once and expires in an hour.
              </p>
              <button type="button" onClick={onBack} className="text-sm link">
                Back to sign in
              </button>
            </>
          ) : (
            <>
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

              {error ? (
                <p className="text-sm" style={{ color: "var(--text-danger)" }}>
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
                {busy ? "Sending…" : "Send a reset link"}
              </button>
              <button type="button" onClick={onBack} className="text-sm link">
                Back to sign in
              </button>
            </>
          )}
        </form>
        <PageCredit />
      </div>
    </div>
  );
}

/** The page the emailed link lands on, where the new password is chosen. */
export function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // A dead link, whether it never had a token or the server just refused
  // one that did (expired, already used): either way the next step is the
  // same request-a-new-one form the sign-in screen already has, so this
  // reuses it rather than sending somebody hunting for it themselves.
  const [requestNew, setRequestNew] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.resetPassword({
      token,
      newPassword: password,
    });
    setBusy(false);
    if (error) {
      setError(
        error.message ?? "That link has expired or has already been used.",
      );
      return;
    }
    setDone(true);
  }

  const box = {
    borderColor: "var(--border)",
    background: "var(--surface-raised)",
  };

  // However they got here empty-handed, this is the same screen the "forgot
  // your password" link on sign-in shows — request the link is the only
  // recovery there is for a dead one, so both funnel into it.
  if (requestNew) {
    return <ForgotPassword onBack={() => setRequestNew(false)} />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded border p-6"
          style={box}
        >
          <h1 className="text-lg font-semibold">Choose a new password</h1>

          {done ? (
            <>
              <p className="text-sm">
                Done. Sign in with it and you will land in the right place — the
                app itself, or your account if this login only manages a
                subscription.
              </p>
              {/*
               * Always "/", never a guess at "/account": this screen has no
               * session, so it cannot itself tell a billing-only account
               * (sentrello.com, no organization here) from an ordinary one
               * apart. Sending everyone to "/account" would be a dead link on
               * every self-hosted instance, which has no such route at all.
               * "/" re-enters the shell (`App.tsx`), and the shell already
               * knows how to tell them apart — `belongsHere`/`accountPath`
               * from `/api/_meta` — once they sign in there, so it sends a
               * billing-only account on to its account page rather than the
               * empty application a member of nothing would otherwise see.
               */}
              <a
                href="/"
                className="inline-block rounded px-3 py-2 text-sm font-medium"
                style={{
                  background: "var(--brand-on-white-text)",
                  color: "var(--color-neutral-50)",
                }}
              >
                Sign in
              </a>
            </>
          ) : !token ? (
            <>
              <p className="text-sm" style={{ color: "var(--text-danger)" }}>
                This link is missing its token. Ask for another.
              </p>
              <button
                type="button"
                onClick={() => setRequestNew(true)}
                className="w-full rounded px-3 py-2 text-sm font-medium"
                style={{
                  background: "var(--brand-on-white-text)",
                  color: "var(--color-neutral-50)",
                }}
              >
                Get a new link
              </button>
              <a href="/" className="block text-center text-sm link">
                Back to sign in
              </a>
            </>
          ) : (
            <>
              <label className="block space-y-1 text-sm">
                <span>New password</span>
                <input
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded border px-2 py-1"
                  style={{ borderColor: "var(--border)" }}
                />
                <span
                  className="block text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  At least 12 characters. A few unrelated words work well.
                </span>
              </label>

              {error ? (
                <>
                  <p
                    className="text-sm"
                    style={{ color: "var(--text-danger)" }}
                  >
                    {error}
                  </p>
                  <button
                    type="button"
                    onClick={() => setRequestNew(true)}
                    className="text-sm link"
                  >
                    Get a new link
                  </button>
                </>
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
                {busy ? "Saving…" : "Save and sign in"}
              </button>
              <a href="/" className="block text-center text-sm link">
                Back to sign in
              </a>
            </>
          )}
        </form>
        <PageCredit />
      </div>
    </div>
  );
}

import { type FormEvent, useEffect, useState } from "react";
import { authClient } from "../lib/auth";
import { AuthShell } from "../lib/auth-shell";
import { PageCredit } from "../lib/credit";
import { Button, Field, Input } from "../lib/ui";

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

  if (mailConfigured === false) {
    return (
      <AuthShell title="No email on this instance" footer={<PageCredit />}>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          This Sentrello has no mail configured, so it cannot send you a reset
          link. On the machine running it:
        </p>
        <pre className="overflow-x-auto rounded border p-2 text-xs border-line">
          <code>sentrello reset-password {email || "you@example.com"}</code>
        </pre>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Configure email in Settings afterwards and this page will send a link
          instead.
        </p>
        <button type="button" onClick={onBack} className="text-sm link">
          Back to sign in
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password" footer={<PageCredit />}>
      <form onSubmit={onSubmit} className="flex flex-col gap-(--gap-stack)">
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
            <Field label="Email">
              <Input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            {error ? (
              <p className="text-sm" style={{ color: "var(--text-danger)" }}>
                {error}
              </p>
            ) : null}

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Sending…" : "Send a reset link"}
            </Button>
            <button type="button" onClick={onBack} className="text-sm link">
              Back to sign in
            </button>
          </>
        )}
      </form>
    </AuthShell>
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

  // However they got here empty-handed, this is the same screen the "forgot
  // your password" link on sign-in shows — request the link is the only
  // recovery there is for a dead one, so both funnel into it.
  if (requestNew) {
    return <ForgotPassword onBack={() => setRequestNew(false)} />;
  }

  return (
    <AuthShell title="Choose a new password" footer={<PageCredit />}>
      <form onSubmit={onSubmit} className="flex flex-col gap-(--gap-stack)">
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
              className="inline-block rounded px-3 py-2 text-center font-medium text-sm no-underline"
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
            <Button
              type="button"
              onClick={() => setRequestNew(true)}
              className="w-full"
            >
              Get a new link
            </Button>
            <a href="/" className="block text-center text-sm link">
              Back to sign in
            </a>
          </>
        ) : (
          <>
            <Field
              label="New password"
              hint="At least 12 characters. A few unrelated words work well."
            >
              <Input
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            {error ? (
              <>
                <p className="text-sm" style={{ color: "var(--text-danger)" }}>
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

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Saving…" : "Save and sign in"}
            </Button>
            <a href="/" className="block text-center text-sm link">
              Back to sign in
            </a>
          </>
        )}
      </form>
    </AuthShell>
  );
}

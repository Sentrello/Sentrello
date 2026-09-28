import { type FormEvent, useEffect, useState } from "react";
import { authClient } from "../lib/auth";
import { AuthShell } from "../lib/auth-shell";
import { PageCredit } from "../lib/credit";
import { Button, Field, Input, Warning, muted } from "../lib/ui";
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
      return;
    }
    landOnTheDashboard();
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
    <AuthShell
      title="Sign in to Sentrello"
      footer={
        <>
          <PageCredit />
          <SourceOffer />
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-(--gap-stack)">
        <Field label="Email">
          <Input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        {/*
          `Input`, not `SecretInput`. The secret variant carries opt-outs that
          keep a password manager away from a field, which is right for an API
          key somebody is reading off a screen and exactly wrong here: this is
          the field a password manager exists to fill.
        */}
        <Field label="Password">
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {error ? <Warning>{error}</Warning> : null}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>

        <button
          type="button"
          onClick={() => setForgot(true)}
          className="w-full text-sm link-muted"
        >
          Forgot your password?
        </button>
      </form>
    </AuthShell>
  );
}

/**
 * The AGPL's section 13 offer, where somebody who is not signed in can read it.
 *
 * The licence owes the corresponding source to anybody who interacts with this
 * over a network, whether or not they ever hold a copy — so an offer only
 * visible after signing in satisfies the clause for precisely the people who
 * did not need it. This is the first screen everybody meets.
 *
 * The address comes from the server rather than being written here, because a
 * business that has modified Sentrello owes its customers *its* source and not
 * ours, and the instance is the only thing that knows which it is.
 */
function SourceOffer() {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/_source")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { source?: string } | null) =>
        setSource(body?.source ?? null),
      )
      // A missing offer is not worth an error on the sign-in screen; the
      // endpoint is public and static, so silence here means the instance is
      // already in trouble in louder ways.
      .catch(() => {});
  }, []);

  if (!source) return null;
  return (
    // The class belongs on the link; on the paragraph it turns the whole line
    // inline. See the note in credit.tsx.
    <p className="mt-2 text-center text-xs" style={muted}>
      <a
        className="link-muted"
        href={source}
        target="_blank"
        rel="noreferrer noopener"
      >
        Source code
      </a>{" "}
      — AGPL-3.0
    </p>
  );
}

/**
 * The second factor, asked for once the password was right.
 *
 * A backup code is accepted in the same box. Somebody whose phone is in a
 * river is exactly the person who cannot find a second link to click, and the
 * two codes are different enough lengths to tell apart without asking.
 */
/**
 * Signing in lands you at the start, wherever you were refused.
 *
 * The address bar survives a sign-in: a session that ran out on the invoice
 * you were reading, or a link somebody sent you, left `/invoicing` in it — so
 * the first thing after typing a password was a screen chosen by whatever had
 * happened before it. James, 27 September 2026: it should be the dashboard,
 * every time.
 *
 * `/` rather than `/dashboard`, because the screen somebody lands on is a
 * preference (`landingPage`, on Your profile) and the root is what reads it.
 * The default is the first screen the instance offers, which is the
 * dashboard.
 *
 * A whole navigation rather than a router push: everything React was holding
 * belonged to a signed-out reader, and the cheapest way to be certain none of
 * it survives is to start the application again.
 */
function landOnTheDashboard() {
  window.location.assign("/");
}

function TwoFactorPrompt({ onCancel }: { onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * How many authenticator codes have been turned away.
   *
   * One is a typo and needs no explanation. Two in a row, on a product
   * somebody runs on their own machine, has a cause worth naming: a code is
   * derived from the time on both sides, so a server whose clock has drifted
   * refuses everybody's code at once and says only that the code was wrong.
   * Whoever is standing at this screen concludes their phone is broken, and
   * every other account is locked out behind them.
   */
  const [misses, setMisses] = useState(0);

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
    if (error) {
      setError(error.message ?? "That code was not accepted");
      if (trimmed.length <= 6) setMisses((n) => n + 1);
      return;
    }
    landOnTheDashboard();
  }

  return (
    <AuthShell title="Enter your code" footer={<PageCredit />}>
      <form onSubmit={onSubmit} className="flex flex-col gap-(--gap-stack)">
        <p className="text-sm" style={muted}>
          From your authenticator app, or one of your backup codes.
        </p>

        <Field label="Code">
          <Input
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>

        <label className="flex items-center gap-(--gap-toolbar) text-sm">
          <input
            type="checkbox"
            checked={trust}
            onChange={(e) => setTrust(e.target.checked)}
          />
          Do not ask on this device for 30 days
        </label>

        {error ? <Warning>{error}</Warning> : null}

        {misses >= 2 ? (
          <p className="text-sm" style={muted}>
            Still refused? Check the clock on the machine Sentrello runs on. A
            code is worked out from the time at both ends, so a server that has
            drifted by more than half a minute turns down every code there is.
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Checking…" : "Continue"}
        </Button>

        <button
          type="button"
          onClick={onCancel}
          className="w-full text-sm link-muted"
        >
          Start again
        </button>
      </form>
    </AuthShell>
  );
}

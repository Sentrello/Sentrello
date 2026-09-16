import { type FormEvent, useEffect, useState } from "react";
import { PageCredit } from "../lib/credit";
import { policyLabel } from "./users/policy-ui";

/**
 * Where an invitation link lands.
 *
 * The person holding it has no account and no session — this screen is
 * reachable before sign-in for the same reason the reset-password page is.
 * It asks the server what the link is for, then asks the person for exactly
 * what is missing: nothing if they are already signed in as the invited
 * address, their password if they have an account here, or a name and a new
 * password if they do not. Accepting signs them in to the inviting business.
 *
 * A dead link says why in plain words — expired, withdrawn, already used —
 * because "invalid token" tells somebody standing in front of a colleague
 * nothing about whose desk to walk back to.
 */

interface InvitationInfo {
  email: string;
  role: string | null;
  organization: string;
  userExists: boolean;
  signedInAsInvitee: boolean;
}

export function AcceptInvitation() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setDead("This link is missing its token. Ask to be invited again.");
      setLoading(false);
      return;
    }
    fetch(`/api/invitations/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        if (res.ok) setInfo(body as unknown as InvitationInfo);
        else {
          setDead(
            body?.message ??
              "This invitation does not exist. Check the link, or ask to be invited again.",
          );
        }
      })
      .catch(() => setDead("Could not reach the server. Try again."))
      .finally(() => setLoading(false));
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/accept`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            info?.signedInAsInvitee ? {} : { name, password },
          ),
        },
      );
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      if (!res.ok) {
        setError(
          body?.message ?? body?.error ?? "Could not accept the invitation",
        );
        return;
      }
      // Signed in, and to the right business: the shell takes it from here.
      window.location.replace("/");
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const box = {
    borderColor: "var(--border)",
    background: "var(--surface-raised)",
  };

  const body = loading ? (
    <p className="text-sm" style={{ color: "var(--text-muted)" }}>
      Checking the invitation…
    </p>
  ) : dead ? (
    <>
      <h1 className="text-lg font-semibold">This link no longer works</h1>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        {dead}
      </p>
      <a href="/" className="text-sm link">
        Go to sign in
      </a>
    </>
  ) : info ? (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Join {info.organization}</h1>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        You were invited as <strong>{info.email}</strong>
        {info.role ? <> — {policyLabel(info.role)}</> : null}. Only that address
        can accept.
      </p>

      {info.signedInAsInvitee ? null : info.userExists ? (
        <label className="block space-y-1 text-sm">
          <span>Your password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border px-2 py-1"
            style={{ borderColor: "var(--border)" }}
          />
          <span
            className="block text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            You already have an account here — this signs you in with it.
          </span>
        </label>
      ) : (
        <>
          <label className="block space-y-1 text-sm">
            <span>Your name</span>
            <input
              type="text"
              required
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border px-2 py-1"
              style={{ borderColor: "var(--border)" }}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Choose a password</span>
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
        </>
      )}

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
        {busy ? "Joining…" : `Join ${info.organization}`}
      </button>
    </form>
  ) : null;

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="space-y-4 rounded border p-6" style={box}>
          {body}
        </div>
        <PageCredit />
      </div>
    </div>
  );
}

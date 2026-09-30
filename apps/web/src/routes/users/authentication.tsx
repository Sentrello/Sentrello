import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, may } from "../../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  REFUSED,
  SecretInput,
  SectionHeading,
  muted,
} from "../../lib/ui";
import { policyLabel } from "./policy-ui";

/**
 * The rules for signing in, and what this instance's own deployment means
 * for them.
 *
 * `SignInRules` is lifted from `user-groups.tsx` unchanged — the two-factor,
 * password and session-length rules already live at `GET`/`PUT
 * /api/users/policy`. What is new is `Diagnostics`: the three facts
 * this screen needs to surface,
 * none of them readable from the browser until `GET /api/users/diagnostics`
 * existed — which header this instance trusts for a caller's address and
 * what this request resolved to, a warning when the base URL is not
 * `https`, and a warning when the instance has one administrator and no
 * mail configured.
 */

interface RoleInfo {
  role: string;
  builtIn: boolean;
  allows: Record<string, string[]>;
}

interface Policy {
  requireEmailVerified: boolean;
  requireTwoFactorFor: string[];
  minPasswordLength: number;
  sessionDays: number | null;
  lockoutAfterAttempts: number;
  lockoutMinutes: number;
  eventRetentionDays: number;
}

interface Diagnostics {
  ipHeader: string;
  resolvedIp: string;
  baseUrl: string;
  https: boolean;
  mailConfigured: boolean;
  administrators: number;
}

/**
 * Whether an administrator locked out right now has no route back through
 * the browser: one administrator, and no mail to send them a reset link.
 *
 * Exported and tested on its own (`authentication.test.ts`) rather than only
 * exercised through the rendered warning.
 */
export function singleAdministratorNoMail(
  d: Pick<Diagnostics, "administrators" | "mailConfigured">,
): boolean {
  return d.administrators <= 1 && !d.mailConfigured;
}

export function Authentication() {
  return (
    <Page width="prose">
      <SignInRules />
      <GoogleSignIn />
      <Diagnostics />
    </Page>
  );
}

/**
 * Google sign-in, connected from here rather than from a file on the server.
 *
 * It was `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and nothing else, so
 * an owner who wanted it needed shell access to the machine running their
 * business. The details are checked against Google before they are stored —
 * credentials saved and wrong fail later, on the sign-in page, in front of
 * whoever the owner was trying to let in.
 */
function GoogleSignIn() {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [restart, setRestart] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["social-sign-in"],
    queryFn: () =>
      api<{
        google: {
          clientId: string | null;
          connected: boolean;
          fromEnvironment: boolean;
          enabled: boolean;
          verifiedAt: string | null;
        };
        redirectUri: string;
        canStoreSecrets: boolean;
      }>("/api/users/social-sign-in"),
  });

  const connect = useMutation({
    mutationFn: () =>
      api("/api/users/social-sign-in/google", {
        method: "PUT",
        body: JSON.stringify({ clientId, clientSecret }),
      }),
    onSuccess: () => {
      setClientSecret("");
      setRestart(true);
      qc.invalidateQueries({ queryKey: ["social-sign-in"] });
    },
  });

  const disconnect = useMutation({
    mutationFn: () =>
      api("/api/users/social-sign-in/google", { method: "DELETE" }),
    onSuccess: () => {
      setRestart(true);
      qc.invalidateQueries({ queryKey: ["social-sign-in"] });
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const google = data.google;

  return (
    <Card className="flex flex-col gap-(--gap-toolbar)">
      <SectionHeading>Signing in with Google</SectionHeading>
      <p className="text-sm" style={muted}>
        Optional. With it on, people can use the Google account they already
        have instead of another password. Create an OAuth client in the Google
        Cloud console, paste its two values here, and give it the address below
        as an authorised redirect URI — Google refuses anything it was not told
        about in advance.
      </p>

      <Field label="Authorised redirect URI">
        <Input readOnly value={data.redirectUri} />
      </Field>

      {google.fromEnvironment ? (
        <p className="text-sm" style={muted}>
          Connected through <code>GOOGLE_CLIENT_ID</code> and{" "}
          <code>GOOGLE_CLIENT_SECRET</code> on this server, which is why the
          boxes below are empty. Saving details here replaces them.
        </p>
      ) : google.connected ? (
        <p className="text-sm" style={muted}>
          Connected as <code>{google.clientId}</code>
          {google.verifiedAt
            ? `, checked against Google on ${new Date(google.verifiedAt).toISOString().slice(0, 10)}`
            : ""}
          .
        </p>
      ) : null}

      {!data.canStoreSecrets ? (
        <p className="text-sm" style={warning}>
          This instance has no secret key, so it cannot store a credential. Set{" "}
          <code>SENTRELLO_SECRET_KEY</code> and restart before connecting
          anything here.
        </p>
      ) : null}

      <Field label="Client ID">
        <Input
          value={clientId}
          placeholder={google.clientId ?? "…apps.googleusercontent.com"}
          onChange={(e) => setClientId(e.target.value)}
        />
      </Field>
      <Field
        label="Client secret"
        hint="Stored sealed, and never shown again after you save it."
      >
        {/*
          `SecretInput`, not a bare password box. A browser that sees
          `type="password"` concludes it has found a credential worth keeping,
          saves it, and autofills it into the next password box it meets —
          which is the sign-in screen, and which locked an owner out of his
          own business the first time it happened.
        */}
        <SecretInput
          value={clientSecret}
          placeholder="GOCSPX-…"
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </Field>

      <div className="flex gap-(--gap-toolbar)">
        <Button
          disabled={
            connect.isPending ||
            !clientId.trim() ||
            !clientSecret.trim() ||
            !may("settings", "update")
          }
          onClick={() => connect.mutate()}
        >
          {connect.isPending ? "Checking with Google…" : "Check and connect"}
        </Button>
        {google.connected && !google.fromEnvironment ? (
          <Button
            variant="secondary"
            disabled={disconnect.isPending || !may("settings", "update")}
            onClick={() => disconnect.mutate()}
          >
            Disconnect
          </Button>
        ) : null}
      </div>

      {connect.error ? <ErrorNote error={connect.error} /> : null}
      {disconnect.error ? <ErrorNote error={disconnect.error} /> : null}

      {/*
        The one surprising thing here, said plainly. Which providers exist is
        decided when the server starts, so a change made now is a change the
        sign-in page shows after a restart.
      */}
      {restart ? (
        <p className="text-sm" style={warning}>
          Saved. Restart the instance for the sign-in page to catch up —{" "}
          <code>docker compose up -d</code> on the host.
        </p>
      ) : null}
    </Card>
  );
}

/** The rules for getting in: who needs a second factor, and how long a session lasts. */
function SignInRules() {
  const qc = useQueryClient();
  const maySave = may("settings", "update");
  /* The reason these tick boxes are dead, for a keyboard and a tablet. A
     `title` is the mouse half of it and was the only half. */
  const refusedId = useId();

  const policy = useQuery({
    queryKey: ["user-policy"],
    queryFn: () => api<{ policy: Policy }>("/api/users/policy"),
  });
  const roles = useQuery({
    queryKey: ["user-roles"],
    queryFn: () => api<{ roles: RoleInfo[] }>("/api/users/roles"),
  });

  const save = useMutation({
    mutationFn: (next: Partial<Policy>) =>
      api("/api/users/policy", {
        method: "PUT",
        body: JSON.stringify(next),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-policy"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  if (policy.isLoading || roles.isLoading) return <Loading />;
  if (policy.error) return <ErrorNote error={policy.error} />;
  const current = policy.data?.policy;
  if (!current) return null;

  return (
    <Card className="flex flex-col gap-(--gap-toolbar)">
      {maySave ? null : (
        <span id={refusedId} className="sr-only">
          {REFUSED}
        </span>
      )}
      <div>
        <SectionHeading>Signing in</SectionHeading>
        <p className="text-sm" style={muted}>
          Who has to use a second factor, and how long somebody stays signed in.
        </p>
      </div>

      <div>
        <p className="text-sm" style={muted}>
          Require two-factor for
        </p>
        <div className="mt-(--gap-tight) flex flex-wrap gap-(--gap-toolbar) text-sm">
          {(roles.data?.roles ?? []).map((role) => (
            <label
              key={role.role}
              className="flex items-center gap-(--gap-tight)"
            >
              <input
                type="checkbox"
                checked={current.requireTwoFactorFor.includes(role.role)}
                disabled={!maySave}
                title={maySave ? undefined : REFUSED}
                aria-describedby={maySave ? undefined : refusedId}
                onChange={(e) =>
                  save.mutate({
                    requireTwoFactorFor: e.target.checked
                      ? [...current.requireTwoFactorFor, role.role]
                      : current.requireTwoFactorFor.filter(
                          (r) => r !== role.role,
                        ),
                  })
                }
              />
              {policyLabel(role.role)}
            </label>
          ))}
        </div>
        <p className="mt-(--gap-tight) text-xs" style={muted}>
          The person who can move money is not the person who clocks in on a
          shared tablet, so this is per role rather than for everybody.
        </p>
      </div>

      {/*
        Off on every instance until somebody turns it on, and the server
        refuses to turn it on without mail configured — because a business that
        cannot send a confirmation link and requires one has locked itself out.
        The refusal comes back as an error under the field rather than being
        pre-empted here, so the screen never has to know how mail is set up.

        `checked`, not `defaultChecked` — the same as the two-factor boxes
        above, and for a reason this field showed plainly: an uncontrolled box
        keeps whatever was clicked even when the server refuses it, so the
        setting sat there looking switched on, beside the error saying it had
        not been, until a reload quietly put it back.
      */}
      <div>
        <label className="flex items-center gap-(--gap-toolbar) text-sm">
          <input
            type="checkbox"
            checked={current.requireEmailVerified}
            disabled={!maySave}
            title={maySave ? undefined : REFUSED}
            aria-describedby={maySave ? undefined : refusedId}
            onChange={(e) =>
              save.mutate({ requireEmailVerified: e.target.checked })
            }
          />
          Require a confirmed email address before signing in
        </label>
        <p className="mt-(--gap-tight) text-xs" style={muted}>
          Needs email configured — everybody has to be able to receive the link,
          including you.
        </p>
      </div>

      <div className="grid gap-(--gap-toolbar) sm:grid-cols-2">
        <Field label="Shortest password" hint="Between 8 and 72 characters.">
          <Input
            needs={{ settings: ["update"] }}
            type="number"
            defaultValue={current.minPasswordLength}
            onBlur={(e) =>
              save.mutate({ minPasswordLength: Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label="Stay signed in for"
          hint="Days. Leave blank to use the platform's own timing."
        >
          <Input
            needs={{ settings: ["update"] }}
            type="number"
            defaultValue={current.sessionDays ?? ""}
            onBlur={(e) =>
              save.mutate({
                sessionDays: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
        </Field>
      </div>

      {/*
        The lockout half of what this screen is named for. `PUT
        /api/users/policy` has taken these three since the lockout landed and
        nothing asked for them, so the only way to turn a lock off, lengthen
        it, or change how long history is kept was to write to the database by
        hand — on the one screen the spec calls "sign-in rules, two-factor,
        lockout".

        Retention is here rather than on its own screen because of what the
        server refuses: a retention window shorter than the lockout window
        makes a lock arbitrary, since the prune can delete either the failures
        that caused it or the success that would clear it. The route rejects
        that pairing with a message saying so, which is only useful if the two
        numbers are set in the same place.
      */}
      <div className="grid gap-(--gap-toolbar) sm:grid-cols-3">
        <Field
          label="Lock after"
          hint="Failed attempts in a row. Zero turns locking off."
        >
          <Input
            needs={{ settings: ["update"] }}
            type="number"
            defaultValue={current.lockoutAfterAttempts}
            onBlur={(e) =>
              save.mutate({ lockoutAfterAttempts: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Locked for" hint="Minutes. The lock then lifts itself.">
          <Input
            needs={{ settings: ["update"] }}
            type="number"
            defaultValue={current.lockoutMinutes}
            onBlur={(e) =>
              save.mutate({ lockoutMinutes: Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label="Keep history for"
          hint="Days. Zero keeps it forever, and it cannot be shorter than the lock."
        >
          <Input
            needs={{ settings: ["update"] }}
            type="number"
            defaultValue={current.eventRetentionDays}
            onBlur={(e) =>
              save.mutate({ eventRetentionDays: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

const warning = { color: "var(--text-warning)" };

/** What this instance's deployment means for signing in. */
function Diagnostics() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["users-diagnostics"],
    queryFn: () => api<Diagnostics>("/api/users/diagnostics"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const d = data;
  if (!d) return null;

  return (
    <Card className="flex flex-col gap-(--gap-toolbar)">
      <SectionHeading>This instance</SectionHeading>
      <dl className="grid gap-x-6 gap-y-(--gap-toolbar) text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">Client address</dt>
          <dd style={muted}>
            trusts <code>{d.ipHeader}</code>, resolved to{" "}
            <code>{d.resolvedIp}</code> for this request
          </dd>
        </div>
        <div>
          <dt className="font-medium">Base URL</dt>
          <dd style={muted}>{d.baseUrl}</dd>
        </div>
      </dl>
      <p className="text-xs" style={muted}>
        Lockout is keyed on the address above. If every sign-in looks like it
        comes from the same place, this is naming the wrong header —
        <code> SENTRELLO_CLIENT_IP_HEADER</code> names another.
      </p>

      {!d.https ? (
        <p className="text-sm" style={warning}>
          The base URL is not https. A session cookie marked Secure is not sent
          over plain HTTP, so sign-in will appear to succeed and then do
          nothing.
        </p>
      ) : null}

      {singleAdministratorNoMail(d) ? (
        <p className="text-sm" style={warning}>
          One administrator, and no mail configured: if they are locked out,
          there is no route back through the browser. On the host,{" "}
          <code>sentrello reset-password &lt;email&gt;</code> or{" "}
          <code>sentrello unlock &lt;email&gt;</code> is the way back in.
        </p>
      ) : null}
    </Card>
  );
}

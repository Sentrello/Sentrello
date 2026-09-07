import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Card, ErrorNote, Field, Input, Loading, muted } from "../../lib/ui";

/**
 * The rules for signing in, and what this instance's own deployment means
 * for them.
 *
 * `SignInRules` is lifted from `user-groups.tsx` unchanged — the two-factor,
 * password and session-length rules already live at `GET`/`PUT
 * /api/users/policy`. What is new is `Diagnostics`: the three facts
 * `docs/plan/Users-IAM-Console-Design.md` §8 asks this screen to surface,
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
 * exercised through the rendered warning, per Ruling 39.
 */
export function singleAdministratorNoMail(
  d: Pick<Diagnostics, "administrators" | "mailConfigured">,
): boolean {
  return d.administrators <= 1 && !d.mailConfigured;
}

export function Authentication() {
  return (
    <div className="space-y-4">
      <SignInRules />
      <Diagnostics />
    </div>
  );
}

/** The rules for getting in: who needs a second factor, and how long a session lasts. */
function SignInRules() {
  const qc = useQueryClient();

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
    <Card>
      <p className="font-medium">Signing in</p>
      <p className="mt-1 text-sm" style={muted}>
        Who has to use a second factor, and how long somebody stays signed in.
      </p>

      <div className="mt-3">
        <p className="text-sm" style={muted}>
          Require two-factor for
        </p>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {(roles.data?.roles ?? []).map((role) => (
            <label key={role.role} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={current.requireTwoFactorFor.includes(role.role)}
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
              {role.role}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs" style={muted}>
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
      <div className="mt-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={current.requireEmailVerified}
            onChange={(e) =>
              save.mutate({ requireEmailVerified: e.target.checked })
            }
          />
          Require a confirmed email address before signing in
        </label>
        <p className="mt-1 text-xs" style={muted}>
          Needs email configured — everybody has to be able to receive the link,
          including you.
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Shortest password" hint="Between 8 and 72 characters.">
          <Input
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
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field
          label="Lock after"
          hint="Failed attempts in a row. Zero turns locking off."
        >
          <Input
            type="number"
            defaultValue={current.lockoutAfterAttempts}
            onBlur={(e) =>
              save.mutate({ lockoutAfterAttempts: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Locked for" hint="Minutes. The lock then lifts itself.">
          <Input
            type="number"
            defaultValue={current.lockoutMinutes}
            onBlur={(e) =>
              save.mutate({ lockoutMinutes: Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label="Keep history for"
          hint="Days. Zero keeps it for ever, and it cannot be shorter than the lock."
        >
          <Input
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

const warning = { color: "var(--color-warning)" };

/** What this instance's deployment means for signing in — §8's three facts. */
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
    <Card>
      <p className="font-medium">This instance</p>
      <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
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
      <p className="mt-2 text-xs" style={muted}>
        Lockout is keyed on the address above. If every sign-in looks like it
        comes from the same place, this is naming the wrong header —
        <code> SENTRELLO_CLIENT_IP_HEADER</code> names another.
      </p>

      {!d.https ? (
        <p className="mt-3 text-sm" style={warning}>
          The base URL is not https. A session cookie marked Secure is not sent
          over plain HTTP, so sign-in will appear to succeed and then do
          nothing.
        </p>
      ) : null}

      {singleAdministratorNoMail(d) ? (
        <p className="mt-3 text-sm" style={warning}>
          One administrator, and no mail configured: if they are locked out,
          there is no route back through the browser. On the host,{" "}
          <code>sentrello reset-password &lt;email&gt;</code> or{" "}
          <code>sentrello unlock &lt;email&gt;</code> is the way back in.
        </p>
      ) : null}
    </Card>
  );
}

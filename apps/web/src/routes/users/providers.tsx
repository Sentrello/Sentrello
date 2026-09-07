import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Select,
  muted,
} from "../../lib/ui";

/**
 * Signing in with the account a business already has.
 *
 * Lifted from `SsoConnections` in `user-sso.tsx`, unchanged: the screen is
 * arranged around what somebody knows — they know they are "on Google" or
 * "on Microsoft", and they do not know what OpenID Connect is. The protocol
 * is a consequence of the choice, not the question.
 */

interface Connection {
  id: string;
  providerId: string;
  issuer: string;
  domain: string;
  protocol: "oidc" | "saml";
  configured: boolean;
}

interface Kind {
  id: string;
  label: string;
  protocol: "oidc" | "saml";
  needsIssuer: boolean;
}

export function Providers() {
  const qc = useQueryClient();
  const [kind, setKind] = useState("google");
  const [domain, setDomain] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [certificate, setCertificate] = useState("");

  const list = useQuery({
    queryKey: ["user-sso"],
    queryFn: () =>
      api<{ kinds: Kind[]; connections: Connection[] }>("/api/users/sso"),
  });

  const connect = useMutation({
    mutationFn: () =>
      api("/api/users/sso", {
        method: "POST",
        body: JSON.stringify({
          kind,
          domain,
          issuer,
          clientId,
          clientSecret,
          entryPoint,
          certificate,
        }),
      }),
    onSuccess: () => {
      setDomain("");
      setClientId("");
      setClientSecret("");
      setEntryPoint("");
      setCertificate("");
      qc.invalidateQueries({ queryKey: ["user-sso"] });
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      api(`/api/users/sso/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-sso"] }),
  });

  if (list.isLoading) return <Loading />;
  if (list.error) return <ErrorNote error={list.error} />;

  const kinds = list.data?.kinds ?? [];
  const chosen = kinds.find((k) => k.id === kind);
  const connections = list.data?.connections ?? [];

  return (
    <Card>
      <p className="font-medium">Signing in with your own accounts</p>
      <p className="mt-1 text-sm" style={muted}>
        Connect the place your staff already sign in — Google Workspace,
        Microsoft 365, or anything that speaks SAML. Anybody with an address at
        a connected domain is sent there instead of being asked for a password.
      </p>

      {connections.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span>
                <strong>{connection.domain}</strong>
                <span style={muted}>
                  {" "}
                  · {connection.protocol === "saml" ? "SAML" : "OpenID"} ·{" "}
                  {connection.issuer}
                </span>
              </span>
              <Button
                variant="secondary"
                onClick={() => disconnect.mutate(connection.id)}
                disabled={disconnect.isPending}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-xs" style={muted}>
        Disconnecting stops sign-ins from that domain. Everybody who arrived
        through it keeps their account and their roles.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Where your staff sign in">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Email domain"
          hint="Everybody with an address here is sent to your provider."
        >
          <Input
            value={domain}
            placeholder="example.com"
            onChange={(e) => setDomain(e.target.value)}
          />
        </Field>

        {chosen?.needsIssuer ? (
          <Field
            label="Issuer URL"
            hint="Your provider gives you this — it is where its configuration lives."
          >
            <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          </Field>
        ) : null}

        {chosen?.protocol === "oidc" ? (
          <>
            <Field label="Client id">
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </Field>
            <Field label="Client secret">
              <Input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Sign-in URL" hint="Your provider's SAML endpoint.">
              <Input
                value={entryPoint}
                onChange={(e) => setEntryPoint(e.target.value)}
              />
            </Field>
            <Field
              label="Certificate"
              hint="The signing certificate, pasted whole."
            >
              <Input
                value={certificate}
                onChange={(e) => setCertificate(e.target.value)}
              />
            </Field>
          </>
        )}
      </div>

      {connect.error ? <ErrorNote error={connect.error} /> : null}
      <div className="mt-3">
        <Button
          onClick={() => connect.mutate()}
          disabled={connect.isPending || !domain.trim()}
        >
          {connect.isPending ? "Connecting…" : "Connect"}
        </Button>
        <p className="mt-2 text-xs" style={muted}>
          People who sign in this way join as members. Give them a role here
          afterwards — an identity provider says who somebody is, not what they
          may do in your books.
        </p>
      </div>
    </Card>
  );
}

import { secrets } from "@sentrello/module-sdk";
import { fraudPreventionHeaders, missingHeaders } from "./mtd-headers";
import type { ClientContext, ServerContext } from "./mtd-headers";

/**
 * Talking to HMRC, for Making Tax Digital.
 *
 * **The out-of-band flow, and why.** HMRC requires redirect URIs registered in
 * advance, and every business runs this on its own domain. Registering
 * thousands is not a plan, and routing the callback through sentrello.com would
 * mean we handle a customer's HMRC tokens — which would break the one claim
 * this product rests on.
 *
 * HMRC's own answer is OAuth for installed applications: the person authorises
 * on HMRC's site, HMRC shows them a code, and they paste it into their own
 * instance. **The token never touches our servers.** It is stored sealed on
 * theirs, beside their Stripe keys.
 */

const LIVE = "https://api.service.hmrc.gov.uk";
const SANDBOX = "https://test-api.service.hmrc.gov.uk";
/** Where a person signs in to grant authority. Not the API host. */
const SIGN_IN = {
  live: "https://www.tax.service.gov.uk",
  sandbox: "https://test-www.tax.service.gov.uk",
};

export interface HmrcConfig {
  clientId: string;
  clientSecret: string;
  sandbox: boolean;
}

export const apiBase = (config: HmrcConfig) =>
  config.sandbox ? SANDBOX : LIVE;

/**
 * Where to send somebody to authorise this instance.
 *
 * `read:vat write:vat` is the whole scope: see the obligations and returns, and
 * submit one. Nothing broader — an application that asks for more than it needs
 * is one a cautious business declines, and rightly.
 */
export function authoriseUrl(config: HmrcConfig, state: string): string {
  const host = config.sandbox ? SIGN_IN.sandbox : SIGN_IN.live;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    scope: "read:vat write:vat",
    redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
    state,
  });
  return `${host}/oauth/authorize?${query}`;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working, as an ISO string. */
  expiresAt: string;
}

/**
 * The code the person pasted, exchanged for tokens.
 *
 * HMRC's codes are short-lived — minutes — so a flow that asks somebody to
 * authorise and then goes off to do something else has already failed. This is
 * called the moment the code arrives.
 */
export async function exchangeCode(
  config: HmrcConfig,
  code: string,
): Promise<Tokens> {
  const res = await fetch(`${apiBase(config)}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      code,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    /*
     * The message rather than a status, because the two failures look
     * identical from a screen and want different actions: an expired code
     * means authorise again, a wrong secret means fix the configuration.
     */
    throw new Error(
      String(body.error_description ?? body.error ?? "HMRC refused the code"),
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: String(body.refresh_token ?? ""),
    expiresAt: new Date(
      Date.now() + Number(body.expires_in ?? 14400) * 1000,
    ).toISOString(),
  };
}

/**
 * A fresh access token from the refresh token.
 *
 * HMRC's access tokens last four hours and the refresh token eighteen months.
 * A business files four times a year, so **every** submission after the first
 * will begin with a refresh — this path is the normal one, not the exception,
 * and it is worth testing as such.
 */
export async function refreshTokens(
  config: HmrcConfig,
  refreshToken: string,
): Promise<Tokens> {
  const res = await fetch(`${apiBase(config)}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    throw new Error(
      String(
        body.error_description ??
          "HMRC would not refresh the connection — it may need authorising again",
      ),
    );
  }
  return {
    accessToken: body.access_token,
    // HMRC rotates it; keeping the old one would work until it suddenly did not.
    refreshToken: String(body.refresh_token ?? refreshToken),
    expiresAt: new Date(
      Date.now() + Number(body.expires_in ?? 14400) * 1000,
    ).toISOString(),
  };
}

/** Tokens, ready to be stored. Sealed, like every other credential here. */
export function sealTokens(tokens: Tokens): Record<string, string> {
  return {
    accessToken: secrets.seal(tokens.accessToken),
    refreshToken: secrets.seal(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
  };
}

async function call<T>(
  config: HmrcConfig,
  accessToken: string,
  path: string,
  client: ClientContext,
  server: ServerContext,
  init?: RequestInit,
): Promise<T> {
  const fraud = fraudPreventionHeaders(client, server);
  const absent = missingHeaders(fraud);
  if (absent.length) {
    /*
     * Refused here rather than sent and rejected. HMRC's rejection arrives as a
     * generic error at the end of a submission somebody has already attested
     * to; this says which values are missing while it can still be fixed.
     */
    throw new Error(
      `this submission is missing information HMRC requires: ${absent.join(", ")}`,
    );
  }

  const res = await fetch(`${apiBase(config)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.hmrc.1.0+json",
      "content-type": "application/json",
      ...fraud,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      String(body.message ?? body.code ?? `HMRC answered ${res.status}`),
    );
  }
  return body as T;
}

/** What HMRC says is due, and by when. */
export function obligations(
  config: HmrcConfig,
  accessToken: string,
  vrn: string,
  from: string,
  to: string,
  client: ClientContext,
  server: ServerContext,
) {
  return call<{
    obligations: {
      start: string;
      end: string;
      due: string;
      status: string;
      periodKey: string;
    }[];
  }>(
    config,
    accessToken,
    `/organisations/vat/${vrn}/obligations?from=${from}&to=${to}`,
    client,
    server,
  );
}

/**
 * Submitting the return.
 *
 * `finalised` is a legal declaration — the person is confirming the figures are
 * true and complete — so it is never defaulted, never inferred from the
 * presence of the other fields, and the screen has to have asked. A submission
 * cannot be withdrawn.
 */
export function submitReturn(
  config: HmrcConfig,
  accessToken: string,
  vrn: string,
  periodKey: string,
  boxes: Record<string, number>,
  finalised: boolean,
  client: ClientContext,
  server: ServerContext,
) {
  if (!finalised) {
    throw new Error("the declaration has not been agreed to");
  }
  return call<{ processingDate: string; formBundleNumber: string }>(
    config,
    accessToken,
    `/organisations/vat/${vrn}/returns`,
    client,
    server,
    {
      method: "POST",
      body: JSON.stringify({ periodKey, ...boxes, finalised }),
    },
  );
}

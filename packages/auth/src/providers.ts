import { db, eq, schema } from "@sentrello/db";
import { secrets } from "@sentrello/module-sdk";

/**
 * Where the Google sign-in details come from.
 *
 * They used to come from two environment variables and nowhere else, which
 * meant an owner who wanted Google sign-in needed shell access to the machine
 * running their business — and build rule 6 says a third-party integration is
 * set up in a screen, tested and stored, never by editing a file on a server.
 * The published page promising that anything configurable has a screen was
 * wrong about this one.
 *
 * So: the database first, the environment second. The environment path stays
 * because instances already running on it must not lose Google sign-in at the
 * update that introduces the screen, and because an operator who genuinely
 * prefers configuration files has one that still works.
 *
 * Read once, when authentication is built. The provider list is resolved at
 * that moment and rebuilding it under a live process would mean tearing down
 * sessions in flight to save a restart, so the screen says so instead.
 */
export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/** What is stored, opened, or nothing. Never throws: this runs at boot. */
export async function storedProvider(
  provider: string,
): Promise<ProviderCredentials | null> {
  try {
    const [row] = await db
      .select()
      .from(schema.authProviders)
      .where(eq(schema.authProviders.provider, provider))
      .limit(1);
    if (!row || !row.enabled) return null;
    return {
      clientId: row.clientId,
      clientSecret: secrets.open(row.clientSecret),
    };
  } catch (err) {
    /*
     * A database that is not up yet, or a key that cannot open what is
     * stored. Either way this is the first thing that runs, and an instance
     * that will not start because one optional sign-in button could not be
     * configured is worse than an instance without the button.
     */
    console.error("[auth] could not read the stored sign-in provider", err);
    return null;
  }
}

/**
 * The Google configuration, switched off where there is none.
 *
 * `enabled: false` rather than nothing, because that is how the library is
 * told a provider does not exist: it drops those before it looks at the
 * details. An instance nobody has configured offers no Google button at all,
 * rather than one that answers "missing client id" at the moment somebody
 * presses it.
 */
export async function googleProvider(): Promise<
  ProviderCredentials & { enabled: boolean }
> {
  const stored = await storedProvider("google");
  if (stored) return { ...stored, enabled: true };

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret
    ? { clientId, clientSecret, enabled: true }
    : { clientId: "", clientSecret: "", enabled: false };
}

/**
 * Whether the details actually work, asked before they are stored.
 *
 * Verified rather than trusted, like every other integration in the product:
 * credentials that are saved and turn out to be wrong fail later, on a
 * sign-in page, in front of whoever the owner was trying to let in.
 *
 * The check is an authorization-code exchange with a code that cannot be
 * real. Google answers `invalid_client` when the id or the secret is wrong
 * and `invalid_grant` when they are right and the code is not — so the error
 * we are hoping for is the second one. It costs nothing, needs no consent
 * screen, and proves exactly the thing that matters.
 */
export async function verifyGoogle(
  credentials: ProviderCredentials,
  redirectUri: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let answer: Response;
  try {
    answer = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        // Deliberately impossible. We are asking about the client, not a code.
        code: "sentrello-checking-these-details",
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      // A check that hangs is a screen that hangs.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      ok: false,
      error: `could not reach Google: ${(err as Error).message}`,
    };
  }

  const body = (await answer.json().catch(() => ({}))) as {
    error?: string;
    error_description?: string;
  };

  // The one we want: the client is real and the code is not.
  if (body.error === "invalid_grant") return { ok: true };
  if (body.error === "invalid_client") {
    return {
      ok: false,
      error:
        "Google does not recognize that client ID and secret together. Check both, and that they belong to the same OAuth client.",
    };
  }
  if (body.error === "redirect_uri_mismatch") {
    return {
      ok: false,
      error: `Google has no such redirect URI on that client. Add ${redirectUri} to its authorised redirect URIs.`,
    };
  }
  if (answer.ok) {
    // Nothing should succeed here. If it does, something is answering for
    // Google that is not Google.
    return { ok: false, error: "that did not come back from Google" };
  }
  return {
    ok: false,
    error: body.error_description ?? body.error ?? "Google refused the check",
  };
}

/** Where Google sends somebody back to, which it has to be told in advance. */
export function googleRedirectUri(): string {
  const base = process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/auth/callback/google`;
}

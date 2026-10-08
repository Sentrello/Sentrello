import { db, schema } from "@sentrello/db";
import { eq } from "@sentrello/db/orm";
import { asText } from "@sentrello/db/text-columns";
import { knownTimezone } from "@sentrello/db/timezone";
import type { SentrelloApp } from "@sentrello/module-sdk";
import { rateLimit } from "@sentrello/module-sdk";
import { auth, clientIp } from "./index";
import {
  duringBootstrap,
  setupTokenAccepted,
  setupTokenRequired,
} from "./signup-policy";

export interface OwnerDetails {
  email: string;
  password: string;
  name: string;
  organizationName?: string;
  /**
   * Where the business is, from the browser claiming the instance.
   *
   * Sent because an unset timezone is not a neutral state: what day it is
   * decides whether an invoice is late, which month a figure lands in and when
   * a nine o'clock automation fires, and with nothing set the answer comes from
   * UTC or from the server's own clock. The browser already knows, and asking it
   * once at the only moment the whole business is being created beats a setting
   * nobody visits.
   *
   * Never fatal. A name this runtime cannot resolve is dropped and the instance
   * is still claimed — the owner can set it in Settings, and refusing the one
   * request that creates the business over a timezone would be absurd.
   */
  timezone?: string;
}

/**
 * Turns the `set-cookie` a sign-up responded with into the `cookie` header the
 * next request has to send.
 *
 * Passing the response headers straight through looks right and fails silently:
 * the server sees a `set-cookie` on an inbound request, finds no session, and
 * answers 401 with an empty body.
 */
export function asRequestHeaders(responseHeaders: Headers): Headers {
  const setCookie = responseHeaders.get("set-cookie");
  if (!setCookie) return new Headers();
  // strip attributes (Path, HttpOnly, SameSite…) from each cookie pair
  const cookie = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
  return new Headers({ cookie });
}

/** True when this instance has no organization, i.e. nobody owns it yet. */
export async function needsBootstrap(): Promise<boolean> {
  const existing = await db.select().from(schema.organizations).limit(1);
  return existing.length === 0;
}

/**
 * First-run bootstrap. Creates the single organization (the tenant boundary
 * every business query scopes to) and the owner account, then never applies
 * again.
 *
 * Idempotent: a second call finds the organization and returns early.
 */
export async function ensureBootstrapped(owner?: OwnerDetails) {
  if (!(await needsBootstrap())) return { bootstrapped: false as const };
  if (!owner) return { bootstrapped: false as const }; // waiting for the operator

  /*
   * One claim, decided by one statement.
   *
   * `needsBootstrap()` above is a read, and everything below it is a write, so
   * on its own it is a check-then-act: five concurrent claims all passed it and
   * all answered 201, leaving five organizations on an instance built for one,
   * each with its own owner. Measured rather than reasoned about — a
   * double-pressed button does it, or a client that retries. A stranger needs
   * the setup token, which the installer generates — so this is an accident on
   * an ordinary install, and on one deployed without a token it is a second
   * owner the operator never sees.
   *
   * `insert … on conflict do nothing` is atomic however many arrive together.
   * The winner gets the row back; a loser gets nothing and is told the instance
   * is already claimed — unless the row is already theirs, which is the retry
   * the comment below is about.
   */
  const folded = owner.email.trim().toLowerCase();
  const [claimed] = await db
    .insert(schema.instanceClaim)
    .values({ id: 1, email: folded })
    .onConflictDoNothing()
    .returning();

  if (!claimed) {
    const [held] = await db
      .select({ email: schema.instanceClaim.email })
      .from(schema.instanceClaim)
      .limit(1);
    /*
     * Somebody else is part-way through claiming it, or did and it failed.
     *
     * The same operator retrying is let through, because a claim that fell over
     * between the account and the organization has to be recoverable and the
     * credentials are the only thing that says who they are. Anybody else is
     * refused, which is the whole point of the row.
     */
    if (held?.email !== folded) return { bootstrapped: false as const };
  }

  /*
   * And the row comes back out if this does not finish.
   *
   * Otherwise a claim that failed on the way through would leave the instance
   * permanently unclaimable by anybody whose address is not the one in the row —
   * including an operator who mistyped theirs. On the way out rather than in a
   * `finally`, because a claim that succeeded must keep its row.
   */
  try {
    return await claim(owner);
  } catch (err) {
    await db.delete(schema.instanceClaim).where(eq(schema.instanceClaim.id, 1));
    throw err;
  }
}

async function claim(owner: OwnerDetails) {
  // Setup is two steps: create the account, then create the organization. If
  // the second fails, the account exists but the instance is still unclaimed —
  // and a naive retry dies on "email already taken", leaving the instance
  // permanently unclaimable without database surgery. So a retry with the same
  // credentials signs in instead of signing up.
  //
  // This is safe precisely because the instance is unclaimed: there is no
  // organization to join, and the setup token was already checked.
  const signUp = await duringBootstrap(async () => {
    try {
      return await auth.api.signUpEmail({
        body: {
          email: owner.email,
          password: owner.password,
          name: owner.name,
        },
        returnHeaders: true,
      });
    } catch (err) {
      const existing = await auth.api.signInEmail({
        body: { email: owner.email, password: owner.password },
        returnHeaders: true,
      });
      if (!existing) throw err;
      return existing;
    }
  });

  // The organization created here IS the instance's tenant boundary, and the
  // creator gets `creatorRole: "admin"` — the Instance Owner.
  const name = owner.organizationName ?? `${owner.name}'s business`;
  /**
   * The owner's address counts as confirmed.
   *
   * They proved it more strongly than any email link could: they read the
   * setup token off the server's own console. Marking it here is what lets a
   * business switch on "require a confirmed email address" later without
   * locking out the one person who cannot be helped by anybody.
   */
  await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(eq(schema.user.id, signUp.response.user.id));

  const organization = await auth.api.createOrganization({
    body: { name, slug: slugify(name) },
    headers: asRequestHeaders(signUp.headers),
  });

  if (organization && owner.timezone && knownTimezone(owner.timezone)) {
    await db
      .update(schema.organizations)
      .set({ timezone: owner.timezone })
      .where(eq(schema.organizations.id, organization.id));
  }

  return {
    bootstrapped: true as const,
    organization,
    headers: signUp.headers,
  };
}

/**
 * Public first-run endpoints. Every customer install starts here: without them
 * a fresh instance has a sign-in screen and no way to create the account it
 * asks for.
 */
/**
 * Claiming an instance is a once-ever act, so a handful of attempts is
 * generous. Five in a minute leaves room for a mistyped token and none for
 * working through a list.
 */
const BOOTSTRAP_LIMIT = 5;
const BOOTSTRAP_WINDOW_MS = 60_000;

export function registerBootstrapRoutes(app: SentrelloApp) {
  app.get("/api/bootstrap", async (c) => {
    const needed = await needsBootstrap();
    return c.json({
      needed,
      setupTokenRequired: setupTokenRequired(),
    });
  });

  app.post("/api/bootstrap", async (c) => {
    if (!(await needsBootstrap())) {
      // Whoever claimed the instance already did; this must never become a
      // second way in.
      return c.json({ error: "already_bootstrapped" }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    /*
     * Every field read as text, because `!name` does not refuse an object.
     *
     * `{}` is truthy, so a name of `{}` got past the required-fields check and
     * went to the sign-up as it was: an owner called "[object Object]" on the
     * very first screen of an instance, and the organisation's slug derived
     * from it. The claim route is the one place where a bad value cannot be
     * corrected afterwards by somebody with an account, because this *is* how
     * the first account is made.
     */
    const email = asText(body.email, "email");
    const password = asText(body.password, "password");
    const name = asText(body.name, "name");
    const organizationName = asText(body.organizationName, "organizationName");
    const timezone = asText(body.timezone, "timezone");
    const setupToken = asText(body.setupToken, "setupToken");

    // A publicly reachable instance must not be claimable by whoever finds it
    // first; the token proves access to the machine running it.
    //
    // Guessing is limited as well as refused. Better Auth rate-limits its own
    // sign-in routes, but this one is ours, and an unclaimed instance is the
    // most valuable thing on it — whoever claims it becomes the owner.
    const limited = rateLimit(
      `bootstrap:${clientIp(c)}`,
      BOOTSTRAP_LIMIT,
      BOOTSTRAP_WINDOW_MS,
    );
    if (!limited.allowed) {
      return c.json({ error: "too_many_attempts" }, 429, {
        "retry-after": String(limited.retryAfterSeconds),
      });
    }

    if (
      !setupTokenAccepted(setupToken || c.req.header("x-sentrello-setup-token"))
    ) {
      return c.json({ error: "invalid_setup_token" }, 403);
    }
    if (!email || !password || !name) {
      return c.json({ error: "email, password and name are required" }, 400);
    }
    if (password.length < 12) {
      return c.json({ error: "password must be at least 12 characters" }, 400);
    }

    const result = await ensureBootstrapped({
      email,
      password,
      name,
      // Absent, not empty: the business is named after its owner when nobody
      // typed a name, and `""` is a name as far as `??` is concerned.
      organizationName: organizationName || undefined,
      timezone: timezone || undefined,
    });
    if (!result.bootstrapped) {
      return c.json({ error: "already_bootstrapped" }, 409);
    }

    // Hand back the session cookie so the owner is signed in immediately.
    const cookie = result.headers.get("set-cookie");
    if (cookie) c.header("set-cookie", cookie);
    return c.json({ organization: result.organization }, 201);
  });
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "sentrello";
}

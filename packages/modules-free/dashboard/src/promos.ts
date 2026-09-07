import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * The advertisement on the Free dashboard, written once and read everywhere.
 *
 * One 728x90 block at the top of the screen — the Free tier's only advertising,
 * and its copy changes far more often than the product does. Baking the words
 * into the release means waiting for a release to change them, so they are
 * fetched instead, from one document Foothills edits in Master on bmp.
 *
 * Three rules make that safe to ship in a self-hosted product:
 *
 *  - **The instance fetches, the browser never does.** No customer's browser
 *    is made to talk to sentrello.com, so nothing about who is reading the
 *    dashboard leaves the building.
 *  - **Nothing is sent.** It is a plain GET of a public document — no instance
 *    id, no tier, no counts. Telemetry is a separate thing somebody opted into.
 *  - **It is only ever decoration.** A failed fetch, an unreachable server, or
 *    a document that does not validate all end the same way: the built-in copy
 *    below, which is always correct enough to ship.
 *
 * Off entirely with `SENTRELLO_PROMOS=off`, and never fetched on Pro, which
 * has no promo block at all.
 */

/** The leaderboard the dashboard draws, and the only shape a banner may be. */
export const AD_WIDTH = 728;
export const AD_HEIGHT = 90;

/** Used when a document arrives without one. */
const DEFAULT_CTA = "See what Pro adds";

export type Ad =
  | {
      kind: "text";
      headline: string;
      body: string;
      cta: string;
      url: string;
    }
  | { kind: "image"; imageUrl: string; alt: string; url: string };

export interface Promos {
  ad: Ad;
  /** When the document was written, so a stale cache is visible. */
  updatedAt?: string;
  /**
   * When the offer stops being true, if it is the kind that does.
   *
   * A promotion that names a date — "founder pricing until December 31st" —
   * becomes a false claim the morning after, on every instance that has not
   * fetched since. Nobody notices, because the people who would are not the
   * people reading somebody else's dashboard. An expired document falls back
   * to the copy that ships in the box, which makes no promise about a date.
   *
   * Optional: an offer with no end date needs none.
   */
  expiresAt?: string;
}

/** What ships in the box, and what every failure falls back to. */
export const BUILT_IN: Promos = {
  ad: {
    kind: "text",
    headline: "Get paid faster with Sentrello Pro",
    body: "Payment chasing, recurring invoices, reports that balance.",
    cta: DEFAULT_CTA,
    url: "https://sentrello.com/pro",
  },
};

/** Trimmed, capped, and never empty. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed === "" ? null : trimmed;
}

/**
 * A link, and only over TLS.
 *
 * `javascript:` is the obvious one to keep out of an href, but plain `http:`
 * matters too: this URL is put in front of somebody on a page that is
 * otherwise entirely local, and a downgrade to cleartext is the one thing this
 * document could do to a reader.
 */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * What arrived, or nothing.
 *
 * Validated rather than trusted even though we serve it ourselves: a document
 * fetched over the network is input, and the day somebody points
 * `SENTRELLO_PROMOS_URL` at a proxy of their own is not the day to discover
 * this parsed whatever it was handed.
 */
export function validatePromos(input: unknown): Promos | null {
  if (!input || typeof input !== "object") return null;
  const doc = input as Record<string, unknown>;

  const ad = validateAd(doc.ad);
  if (!ad) return null;

  return {
    ad,
    updatedAt: text(doc.updatedAt, 40) ?? undefined,
    expiresAt: text(doc.expiresAt, 40) ?? undefined,
  };
}

function validateAd(input: unknown): Ad | null {
  if (!input || typeof input !== "object") return null;
  const block = input as Record<string, unknown>;
  const url = safeUrl(block.url);
  if (!url) return null;

  if (block.kind === "image") {
    const imageUrl = safeUrl(block.imageUrl);
    if (!imageUrl) return null;
    // Alt text is not optional: a banner with no alt is an advertisement a
    // screen reader announces as "link".
    return { kind: "image", imageUrl, alt: text(block.alt, 120) ?? "", url };
  }

  const headline = text(block.headline, 80);
  if (!headline) return null;
  return {
    kind: "text",
    headline,
    body: text(block.body, 140) ?? "",
    cta: text(block.cta, 40) ?? DEFAULT_CTA,
    url,
  };
}

/**
 * How long a new business is left alone before it is sold to.
 *
 * Set by James, 2026-09-06. The first thing somebody sees after claiming an
 * instance should not be an advertisement: they have not added a contact or
 * raised an invoice yet, and the only call to action on the screen being
 * "spend more money" is the wrong first impression of a product they have
 * just installed. After two months they know whether it is worth paying for,
 * and the offer stops being an interruption and starts being an answer.
 *
 * It is a floor on the business's own age, not on the licence or the process:
 * somebody who has used this for a year does not get two quiet months back
 * because their server was rebuilt.
 */
export const QUIET_DAYS = 60;

/**
 * Whether this business has been here long enough to be offered anything.
 *
 * Missing or unreadable means yes. The alternative is that a business whose
 * creation date cannot be read never sees an offer at all — a commercial hole
 * nobody would notice, because there is nothing on the screen to notice.
 * Being shown an offer early is the smaller of the two failures.
 */
export function pastQuietPeriod(
  since: Date | string | null | undefined,
  now = new Date(),
  quietDays = QUIET_DAYS,
): boolean {
  if (!since) return true;
  const started = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(started.getTime())) return true;
  return now.getTime() - started.getTime() >= quietDays * 86_400_000;
}

/** Where the last good document is kept, beside the other instance state. */
const cacheFile = () =>
  join(resolve(process.env.SENTRELLO_DATA_DIR ?? "/data"), "promos.json");

export function promosEnabled(): boolean {
  return (process.env.SENTRELLO_PROMOS ?? "on").toLowerCase() !== "off";
}

export function promosUrl(): string {
  return process.env.SENTRELLO_PROMOS_URL ?? "https://sentrello.com/api/promos";
}

/**
 * What to show right now.
 *
 * The file if there is one, the built-in copy otherwise. Never a fetch: this
 * runs while somebody is waiting for their dashboard, and a slow or hanging
 * request to another host is not allowed to be the reason it does not paint.
 */
export async function readPromos(now = new Date()): Promise<Promos> {
  if (!promosEnabled()) return BUILT_IN;
  try {
    const raw = await readFile(cacheFile(), "utf8");
    const found = validatePromos(JSON.parse(raw));
    if (!found) return BUILT_IN;
    return expired(found, now) ? BUILT_IN : found;
  } catch {
    return BUILT_IN;
  }
}

/**
 * Whether the offer has stopped being true.
 *
 * A date nobody can read is not an expiry — a document whose `expiresAt` is
 * nonsense keeps showing, because refusing to show anything on a typo would
 * be a worse failure than showing an offer a day too long.
 */
export function expired(promos: Promos, now = new Date()): boolean {
  if (!promos.expiresAt) return false;
  const ends = new Date(promos.expiresAt);
  return !Number.isNaN(ends.getTime()) && ends <= now;
}

/**
 * How old the cache may be before a refresh is worth making.
 *
 * Under an hour, and that is the whole point: the job runs hourly and calls
 * this, so a window of ninety minutes meant every other run returned without
 * asking and copy took up to two hours to appear. Forty-five minutes is still
 * long enough that an instance somebody restarts three times in an afternoon
 * does not ask us three times.
 */
const STALE_AFTER_MS = 45 * 60 * 1000;

/**
 * The first day.
 *
 * The nightly job means a brand-new instance shows the built-in copy until
 * 04:17 tomorrow — up to a day of the wrong words on the screen a new Free
 * user looks at most. So a boot with no cache, or a stale one, refreshes once
 * in the background.
 *
 * Deliberately not awaited by the caller and never able to fail a boot: this
 * is decoration, and an unreachable sentrello.com must not be the reason an
 * instance takes longer to start.
 */
export async function refreshPromosIfStale(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!promosEnabled()) return;
  try {
    const { mtimeMs } = await stat(cacheFile());
    if (Date.now() - mtimeMs < STALE_AFTER_MS) return;
  } catch {
    // No cache at all — this is the first day, which is the case that matters.
  }
  await refreshPromos(fetchImpl);
}

/**
 * Fetching the current document, on a schedule rather than on a page load.
 *
 * Returns what it stored, or null when nothing changed hands — a failure keeps
 * whatever was already cached rather than clearing it, because yesterday's
 * copy is better than none and an outage should not blank the panel.
 */
export async function refreshPromos(
  fetchImpl: typeof fetch = fetch,
): Promise<Promos | null> {
  if (!promosEnabled()) return null;

  try {
    const res = await fetchImpl(promosUrl(), {
      // No credentials, no custom headers: nothing that could identify the
      // instance travels with this.
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const validated = validatePromos(await res.json());
    if (!validated) {
      console.warn("[promos] the document that came back did not validate");
      return null;
    }

    await mkdir(dirname(cacheFile()), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify(validated), { mode: 0o600 });
    return validated;
  } catch (err) {
    // Decoration failing is not an incident. One line, and the old copy stays.
    console.warn(
      `[promos] could not refresh: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

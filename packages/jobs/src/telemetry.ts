import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { db, schema } from "@sentrello/db";
import { count } from "drizzle-orm";

/**
 * What this instance tells us about itself, if it was asked and said yes.
 *
 * Off unless `SENTRELLO_TELEMETRY=on`, which the installer only writes after
 * somebody answers the question at install time. There is no silent
 * phone-home: a self-hosted product that reports on its owner without asking
 * is one nobody should trust with their books, and the whole argument for
 * self-hosting is that the data does not leave the machine.
 *
 * What goes: which version, which tier, which modules are loaded, and roughly
 * how many people use it. What never goes: any customer record, any name,
 * address, email or figure, and no organization identifier. The instance id is
 * a random value the installer generated and means nothing outside the count.
 */

export interface Telemetry {
  instanceId: string;
  version: string;
  tier: "free" | "pro";
  modules: string[];
  /** Banded rather than exact: "how many people" and not "which business". */
  users: string;
}

/** 1, 2–5, 6–10, 11–20, 21+ — enough to size the product, not to identify one. */
export function band(users: number): string {
  if (users <= 1) return "1";
  if (users <= 5) return "2-5";
  if (users <= 10) return "6-10";
  if (users <= 20) return "11-20";
  return "21+";
}

/**
 * The answer, from two places in order: the environment, which is what the
 * installer writes when somebody says yes at install time, and a file in the
 * data directory, which is how the same person changes their mind later from
 * Settings without editing a dotfile on their own server.
 *
 * The environment wins, so a decision made deliberately on the server is never
 * quietly overridden from a browser.
 */
const choicePath = () =>
  `${resolve(process.env.SENTRELLO_DATA_DIR ?? "/data")}/telemetry`;

export async function telemetryEnabled(): Promise<boolean> {
  const fromEnv = (process.env.SENTRELLO_TELEMETRY ?? "").trim().toLowerCase();
  if (fromEnv === "on") return true;
  if (fromEnv === "off") return false;
  try {
    return (await readFile(choicePath(), "utf8")).trim().toLowerCase() === "on";
  } catch {
    // No file and no variable: never asked, so the answer is no.
    return false;
  }
}

/** Whether the answer was fixed on the server, and so cannot be changed here. */
export function telemetryFixedInEnvironment(): boolean {
  const value = (process.env.SENTRELLO_TELEMETRY ?? "").trim().toLowerCase();
  return value === "on" || value === "off";
}

export async function setTelemetryEnabled(on: boolean): Promise<void> {
  // The directory exists on any real install — it is the mounted volume — but
  // not in a checkout, and not on an instance whose volume was remounted
  // somewhere new. Creating it turns a stack trace into a saved preference.
  await mkdir(dirname(choicePath()), { recursive: true });
  await writeFile(choicePath(), on ? "on\n" : "off\n", { mode: 0o600 });
}

export async function sendTelemetry(
  options: {
    tier?: "free" | "pro";
    modules?: string[];
    /** For tests: the endpoint and a clock-free way in. */
    endpoint?: string;
  } = {},
): Promise<{ sent: boolean; reason?: string }> {
  if (!(await telemetryEnabled()))
    return { sent: false, reason: "not enabled" };

  const instanceId = process.env.SENTRELLO_INSTANCE_ID;
  // No id means the installer never wrote one, which means nobody was ever
  // asked. Sending anyway would be the silent phone-home this exists to avoid.
  if (!instanceId) return { sent: false, reason: "no instance id" };

  const endpoint =
    options.endpoint ??
    process.env.SENTRELLO_TELEMETRY_URL ??
    "https://sentrello.com/api/telemetry";

  const [users] = await db.select({ n: count() }).from(schema.user);

  const payload: Telemetry = {
    instanceId,
    version: process.env.SENTRELLO_VERSION ?? "unknown",
    tier: options.tier ?? "free",
    modules: options.modules ?? [],
    users: band(users?.n ?? 0),
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // A hung endpoint must not hold a queue worker for the rest of the day.
      signal: AbortSignal.timeout(10_000),
    });
    return { sent: res.ok, reason: res.ok ? undefined : `http ${res.status}` };
  } catch {
    // Silent. Telemetry failing is our problem, not something to put in the
    // logs of a business that opted in as a favour.
    return { sent: false, reason: "unreachable" };
  }
}

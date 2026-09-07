/**
 * Updating the instance from the Settings screen.
 *
 * The app cannot update itself. It runs inside a container it does not own,
 * and the update replaces that container — so the work belongs to something on
 * the host. The obvious shortcut is to mount the Docker socket and let the app
 * run `docker compose` directly, and it is the wrong one: socket access is
 * root on the machine, so any flaw in a public form endpoint would become a
 * whole-host compromise on every self-hosted instance. A business runs this on
 * the same box as everything else it owns.
 *
 * So the app only ever *asks*. It writes a request into its own data
 * directory; an agent on the host notices, runs the same `sentrello update`
 * a person would type, and writes back what happened. The app's most
 * privileged act is creating a small file in a directory it already writes to.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { licenseKey } from "@sentrello/licensing-client";

/** Where the app and the host agent meet. Nothing else is shared. */
const dataDir = () => resolve(process.env.SENTRELLO_DATA_DIR ?? "/data");
const requestPath = () => `${dataDir()}/update-requested`;
const statusPath = () => `${dataDir()}/update-status.json`;

export interface UpdateStatus {
  /** idle | requested | running | done | failed */
  state: string;
  /** What the agent last said, in words a business owner can act on. */
  message?: string;
  /** The release it was moving to, when it knows. */
  version?: string;
  at?: string;
}

/**
 * The release this instance is running.
 *
 * Baked into the image at build time. "unknown" outside a released build,
 * which is the honest answer when running from a checkout.
 */
export function currentVersion(): string {
  return process.env.SENTRELLO_VERSION ?? "unknown";
}

/**
 * The newest public release, for an instance with no licence.
 *
 * Carries nothing — no key, no instance id, no version — so it tells us only
 * that somebody, somewhere, pressed a button. That matters: never phoning home
 * is a promise Free makes, and this is only ever called from
 * {@link checkForUpdates} when a person asked, never on a timer and never
 * merely because a screen was opened.
 */
async function publicLatestVersion(): Promise<string | null> {
  const server = process.env.SENTRELLO_LICENSE_SERVER_URL?.trim();
  if (!server) return null;

  try {
    const res = await fetch(`${server}/api/distribution/version`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

/** Whether asking is even possible — an instance may have no server to ask. */
export function canCheckForUpdates(): boolean {
  return (process.env.SENTRELLO_LICENSE_SERVER_URL ?? "").trim() !== "";
}

/**
 * What this instance could update to, when somebody asks.
 *
 * A licensed instance is told what its licence entitles; a Free one is told
 * the public release. Both then get the same button, the same wait, and the
 * same right to sit on the version they have until a quiet afternoon — which
 * is the whole point: an update takes the business offline for a minute, and
 * that minute belongs to the business, not to us.
 */
export async function checkForUpdates(): Promise<string | null> {
  return (await licenseKey())
    ? await latestVersion()
    : await publicLatestVersion();
}

/**
 * The release the licence server is offering.
 *
 * Asked of the control plane rather than a registry, because the control plane
 * is the thing that decides what this instance is entitled to — the newest
 * image on a registry may be one whose bundles this licence cannot have.
 *
 * Returns nothing for a Free instance, so opening the Settings screen makes no
 * outbound request. Free asks through {@link checkForUpdates}, on a press.
 */
export async function latestVersion(): Promise<string | null> {
  const key = await licenseKey();
  const server = process.env.SENTRELLO_LICENSE_SERVER_URL?.trim();
  if (!key || !server) return null;

  try {
    const res = await fetch(`${server}/api/distribution/bundles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key: key, arch: "amd64" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    // An instance that cannot reach us keeps working; it simply does not know
    // whether an update exists, and says so rather than claiming to be current.
    return null;
  }
}

/**
 * Whether something other than this button is responsible for the version.
 *
 * Sentrello's own hosts run an image built by a deploy script, with the
 * control plane and Master inside it. Pressing "update" there would swap that
 * image for the public Core one and take sentrello.com's licence server down
 * with it — so the button has to know, and say so, rather than being quietly
 * unavailable because the version string happens to be unreadable.
 */
export function managedExternally(): boolean {
  return (process.env.SENTRELLO_MANAGED ?? "").trim() !== "";
}

/**
 * Newer, older or the same.
 *
 * Compared as numbers per segment, so 0.1.9 is older than 0.1.10 — a string
 * comparison gets that backwards, and the first customer to see it would be
 * told they were up to date while sitting on a release behind.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (candidate === current) return false;
  if (current === "unknown" || candidate === "unknown") return false;

  // Plain releases only. A pre-release sorts as newer on its numbers alone —
  // 0.2.0-rc1 beats 0.1.28 — and offering a business a release candidate
  // because the arithmetic allowed it is not a thing this button should do.
  const plain = /^\d+(\.\d+)*$/;
  if (!plain.test(candidate) || !plain.test(current)) return false;

  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The release this instance could go back to.
 *
 * Written into the data directory by `sentrello update` rather than passed in
 * the environment: the app runs in a container that cannot see the host's
 * compose file, and the data directory is the one thing both sides already
 * share. It also means someone who only ever uses the terminal still gets a
 * working button afterwards.
 *
 * Rolling back changes the code, not the data. Migrations are additive and
 * backward-compatible, so an older release runs against a newer schema — it
 * ignores what it does not know about. Nothing entered since the update is
 * lost, which is the point: an instance that has taken a day of invoices must
 * not throw them away to fix a display bug.
 */
export async function rollbackTarget(): Promise<string | null> {
  try {
    const version = (
      await readFile(`${dataDir()}/rollback-target`, "utf8")
    ).trim();
    // Never offer to "go back" to what is already running.
    if (!version || version === currentVersion()) return null;

    // A Free instance follows the `latest` tag, so after a rollback the
    // recorded target is the word "latest" rather than a number. The agent
    // accepts only digits and dots — rightly, since that string reaches a root
    // command line — so a button offering this would always fail. The terminal
    // path handles it; the button says nothing rather than lying.
    if (!/^\d+(\.\d+)*$/.test(version)) return null;
    return version;
  } catch {
    return null;
  }
}

/**
 * Ask the host to roll back.
 *
 * A separate file from an update request so the agent can tell them apart
 * without having to interpret a version number — the two mean opposite things
 * and guessing from the digits would be a poor way to decide.
 */
export async function requestRollback(version: string): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(`${dataDir()}/rollback-requested`, `${version}\n`, "utf8");
  await writeFile(
    statusPath(),
    JSON.stringify({
      state: "requested",
      version,
      message: "Waiting for the host to pick this up.",
      at: new Date().toISOString(),
    } satisfies UpdateStatus),
    "utf8",
  );
}

export async function readStatus(): Promise<UpdateStatus> {
  try {
    const status = JSON.parse(
      await readFile(statusPath(), "utf8"),
    ) as UpdateStatus;

    // The agent has no way to clear this: the container it would clear it for
    // is the one it just replaced. So a finished update stays on the screen
    // forever unless the version it reports is checked against the version now
    // running — once they agree, the news is that there is no news.
    if (status.state === "done" && status.version === currentVersion()) {
      return { state: "idle" };
    }
    return status;
  } catch {
    return { state: "idle" };
  }
}

/**
 * Ask the host agent to update.
 *
 * Writes the requested version rather than "latest", so the agent applies the
 * release the person actually saw on the screen. Between clicking and the
 * agent waking, a new release could appear, and a business that pressed a
 * button for 0.2.1 should not silently receive 0.3.0.
 */
export async function requestUpdate(version: string): Promise<void> {
  await mkdir(dirname(requestPath()), { recursive: true });
  await writeFile(requestPath(), `${version}\n`, "utf8");
  await writeFile(
    statusPath(),
    JSON.stringify({
      state: "requested",
      version,
      message: "Waiting for the host to pick this up.",
      at: new Date().toISOString(),
    } satisfies UpdateStatus),
    "utf8",
  );
}

/**
 * Whether a host agent is actually listening.
 *
 * Without one the button would write a file nobody reads and the screen would
 * promise an update that never comes. The agent writes this marker when it
 * starts, so the UI can offer instructions instead of a dead button.
 */
/**
 * Ask the host to fetch a fresh licence token and the bundles that go with it.
 *
 * Carries no parameter at all, which makes it the safest of these requests:
 * there is no value for a form to smuggle anything into. The host decides what
 * to fetch from the licence it already holds.
 */
export async function requestSync(): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(`${dataDir()}/sync-requested`, "sync\n", "utf8");
  await writeFile(
    statusPath(),
    JSON.stringify({
      state: "requested",
      message: "Checking your subscription.",
      at: new Date().toISOString(),
    } satisfies UpdateStatus),
    "utf8",
  );
}

export async function agentPresent(): Promise<boolean> {
  try {
    await readFile(`${dataDir()}/update-agent`, "utf8");
    return true;
  } catch {
    return false;
  }
}

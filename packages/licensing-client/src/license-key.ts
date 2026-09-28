import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Where the licence key comes from.
 *
 * Two places, in order: the environment, which is how the installer sets it,
 * and a file in the data directory, which is how someone upgrading from Free
 * inside the app sets it. Environment wins, so a key placed deliberately on the
 * server is never quietly overridden by one typed into a browser.
 *
 * The file exists because a business that has been running Free for three years
 * and decides to buy Pro should not have to SSH into their own server and edit
 * a dotfile at the moment they hand over money.
 */
const dataDir = () => resolve(process.env.SENTRELLO_DATA_DIR ?? "/data");
const keyPath = () => `${dataDir()}/license_key`;

/**
 * The shape of every key this system issues: `SENT-` and four groups from an
 * alphabet with no 0/O or 1/I, because these get retyped off an email by hand.
 *
 * Enforced on the way in and on the way out, and that is not belt-and-braces.
 * The key reaches a shell — `sentrello update` interpolates it into a curl
 * argument — so a value containing a quote or a backtick would escape into a
 * command running as root on the customer's own machine. Before this could be
 * set from a web form it came from a file an operator wrote by hand, and the
 * question never arose.
 */
export const LICENSE_KEY_PATTERN =
  /^SENT-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}(-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}){3}$/;

export function isValidLicenseKey(key: string): boolean {
  return LICENSE_KEY_PATTERN.test(key);
}

/** The key this instance should use, or null if it is running Free. */
export async function licenseKey(): Promise<string | null> {
  const fromEnv = process.env.SENTRELLO_LICENSE_KEY?.trim();
  if (fromEnv) return isValidLicenseKey(fromEnv) ? fromEnv : null;

  try {
    const stored = (await readFile(keyPath(), "utf8")).trim();
    // A file that has been edited into something malformed is treated as
    // absent rather than passed on. Free is a safe place to land; a mangled
    // string reaching a command line is not.
    return isValidLicenseKey(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Store a key entered in the app.
 *
 * Refuses anything that is not the exact shape of a key, so nothing else can
 * ever reach the file. Written 0600: it is not a password, but it is the thing
 * that identifies a paying customer, and the data directory holds the signed
 * licence token beside it under the same protection.
 */
export async function storeLicenseKey(key: string): Promise<void> {
  const trimmed = key.trim().toUpperCase();
  if (!isValidLicenseKey(trimmed)) {
    throw new Error("that does not look like a Sentrello licence key");
  }
  await writeFile(keyPath(), `${trimmed}\n`, { mode: 0o600 });
  await chmod(keyPath(), 0o600);
}

/** Whether the key came from the server's environment rather than the app. */
export function keyIsFromEnvironment(): boolean {
  return Boolean(process.env.SENTRELLO_LICENSE_KEY?.trim());
}

import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A secret that is not a login must not be offered to a password manager.
 *
 * An API key, a webhook signing secret, an SSO client secret — all masked for
 * the same reason a password is, and a browser reasonably concludes from
 * `type="password"` that it has found a credential worth keeping.
 *
 * It then does two harmful things, and both happened here within a minute of
 * each other:
 *
 * 1. It saved a **Stripe secret key** into a password vault, where it syncs
 *    across devices and outlives the key.
 * 2. Having saved it against this site, it autofilled that value into the next
 *    password box it saw — the sign-in screen — so the owner of the business
 *    was told his password was wrong and could not get in. Two symptoms that
 *    looked like unrelated faults, one cause.
 *
 * `SecretInput` says plainly that these are not credentials, in the several
 * dialects that matter. This is a source check rather than a rendering one
 * because the defect is a missing attribute, and the thing worth preventing is
 * the *next* secret field being written the old way.
 */

/** Screens where a password field really is a password. */
const REAL_PASSWORDS = new Set([
  "sign-in.tsx",
  "setup.tsx",
  "profile.tsx",
  "forgot-password.tsx",
]);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path));
    else if (entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("no screen masks a non-login secret with a bare password input", () => {
  const offenders: string[] = [];

  for (const file of tsxFiles(join(import.meta.dir, "..", "routes"))) {
    const name = file.split("/").pop() ?? "";
    if (REAL_PASSWORDS.has(name)) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes('type="password"')) {
      offenders.push(name);
    }
  }

  // Named rather than counted, so a regression says which screen to look at.
  expect(offenders).toEqual([]);
});

test("the shared secret field opts out of every manager that reads a hint", () => {
  const source = readFileSync(join(import.meta.dir, "ui.tsx"), "utf8");
  /*
   * `autocomplete="off"` alone is widely ignored on a password input.
   * `new-password` is the value managers actually respect for "do not fill
   * this", and the three data attributes are the opt-outs 1Password, LastPass
   * and Bitwarden read.
   */
  for (const hint of [
    'autoComplete="new-password"',
    "data-1p-ignore",
    'data-lpignore="true"',
    'data-bwignore="true"',
  ]) {
    expect(source).toContain(hint);
  }
});

/**
 * The passwords people actually choose, refused.
 *
 * NIST SP 800-63B §5.1.1.2 asks that a chosen password be compared against a
 * list of commonly-used, expected or compromised values — and, in the same
 * breath, that composition rules be dropped. Forcing a capital, a digit and a
 * symbol produces `Password1!` and a person who reuses it everywhere; length
 * plus this list is what actually helps.
 *
 * **Local, not an online breach service.** Checking Have I Been Pwned would
 * catch far more, and it is the wrong trade for a product that runs on somebody
 * else's server: it sends a hash of a customer's password to a third party from
 * a machine that otherwise talks to nobody, and it has to decide what to do
 * when that service is unreachable — fail open and the check is theatre, fail
 * closed and an outage stops people setting passwords.
 *
 * This list is short on purpose. It is not trying to be a dictionary; it is
 * trying to catch the passwords that appear in every breach summary, plus the
 * ones somebody types when a product asks for twelve characters and they are in
 * a hurry.
 */
const COMMON = [
  "123456789012",
  "password1234",
  "passwordpassword",
  "qwertyuiop12",
  "111111111111",
  "123456654321",
  "adminadmin12",
  "letmeinletmein",
  "welcome123456",
  "iloveyou1234",
  "monkeymonkey",
  "dragondragon",
  "sunshine1234",
  "princess1234",
  "football1234",
  "baseball1234",
  "trustno1trustno1",
  "changemechangeme",
  "secretsecret",
  "qwerty123456",
  "abc123abc123",
  "password12345",
  "administrator",
  "sentrello1234",
];

/**
 * The keyboard walks and single-character passwords a length rule lets through.
 *
 * Twelve characters of `aaaaaaaaaaaa` or `123456789012` satisfies any length
 * check and is guessed instantly, which is exactly the case a minimum alone
 * cannot see.
 */
function isTrivial(password: string): boolean {
  const lower = password.toLowerCase();
  // One character repeated.
  if (/^(.)\1+$/.test(lower)) return true;
  /*
   * A run up or down the keyboard, measured rather than matched.
   *
   * The first version compared against the literal strings "abc…z" and "0…9",
   * which misses anything that wraps — `0123456789012` is a walk along the
   * number line and is not a substring of it. Counting the longest run where
   * each character steps by exactly one catches those, and catches a partial
   * walk padded with a couple of characters, which the substring test never
   * could.
   */
  let longest = 1;
  let run = 1;
  for (let i = 1; i < lower.length; i += 1) {
    const step = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    run = step === 1 || step === -1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  if (longest >= 8 || longest >= lower.length * 0.7) return true;
  // A short thing repeated to reach the length: "abcabcabcabc".
  for (let size = 1; size <= 4; size += 1) {
    const unit = lower.slice(0, size);
    if (unit.repeat(Math.ceil(lower.length / size)).startsWith(lower)) {
      return true;
    }
  }
  return false;
}

/** Why this password cannot be used, or null if it can. */
export function weakPasswordReason(password: string): string | null {
  const lower = password.toLowerCase();
  if (COMMON.includes(lower)) {
    return "that is one of the most common passwords there is — please choose another";
  }
  if (isTrivial(password)) {
    return "that is a pattern rather than a password — please choose another";
  }
  /*
   * The product's own name, which people reach for because it is on the screen
   * in front of them.
   */
  if (lower.includes("sentrello")) {
    return "please choose something that is not the name of the product";
  }
  return null;
}

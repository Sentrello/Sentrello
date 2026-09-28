/**
 * Third-party credentials, kept where a business can change them.
 *
 * A payment processor is connected from a module's own settings screen — keys
 * pasted in, connection tested, sandbox first, then live — the way it works in
 * WooCommerce or Shopify. Nobody editing a `.env` on a server they may not
 * have shell access to.
 *
 * That means secrets live in the database, and a database ends up in backups,
 * on a replica, and in whatever a support engineer is looking at. So they are
 * sealed here: AES-256-GCM, a random nonce per value, and the ciphertext
 * carries its own authentication tag. A row that has been tampered with fails
 * to open rather than opening to something else.
 *
 * The key comes from `SENTRELLO_SECRET_KEY` if an instance sets one, and
 * otherwise is derived from `BETTER_AUTH_SECRET`, which every instance already
 * has. Deriving rather than reusing means the same bytes are never both a
 * session secret and an encryption key — and it means this works on instances
 * that were installed before any of it existed.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * What a sealed value looks like in a column: `v1.<nonce>.<tag>.<ciphertext>`,
 * base64url throughout.
 *
 * Versioned from the start, because the alternative to a version prefix is
 * guessing, and a scheme that cannot be changed is one that cannot be fixed.
 */
const PREFIX = "v1";

export class MissingSecretKey extends Error {
  constructor() {
    super(
      "no SENTRELLO_SECRET_KEY or BETTER_AUTH_SECRET is set, so stored credentials cannot be read or written",
    );
    this.name = "MissingSecretKey";
  }
}

function key(): Buffer {
  const source =
    process.env.SENTRELLO_SECRET_KEY || process.env.BETTER_AUTH_SECRET || "";
  if (!source) throw new MissingSecretKey();
  // HKDF with a fixed info string: one purpose, one key. If a second thing
  // ever needs its own key, it gets its own info string rather than this one.
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(source),
      Buffer.alloc(0),
      "sentrello:module-secrets",
      32,
    ),
  );
}

/** Whether this instance can store credentials at all. */
export function secretsAvailable(): boolean {
  return Boolean(
    process.env.SENTRELLO_SECRET_KEY || process.env.BETTER_AUTH_SECRET,
  );
}

const b64 = (b: Buffer) => b.toString("base64url");

/** Seals a value for storage. Never returns the same bytes twice. */
export function seal(plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), nonce);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [PREFIX, b64(nonce), b64(cipher.getAuthTag()), b64(body)].join(".");
}

/**
 * Opens a sealed value, or throws.
 *
 * Throwing rather than returning null: every caller here is about to talk to
 * somebody's payment processor, and doing that with a silently empty key
 * produces an error from Stripe about something else entirely.
 */
export function open(sealed: string): string {
  const [version, nonce, tag, body] = sealed.split(".");
  if (version !== PREFIX || !nonce || !tag || !body) {
    throw new Error("that stored credential is not in a format we can read");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(nonce, "base64url"),
  );
  const authTag = Buffer.from(tag, "base64url");
  if (authTag.length !== TAG_BYTES) {
    throw new Error("that stored credential is not in a format we can read");
  }
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Whether a stored string is sealed, so a plain one can be spotted. */
export function isSealed(value: string): boolean {
  return value.startsWith(`${PREFIX}.`);
}

/**
 * The last four characters, for showing a key back to the person who set it.
 *
 * A settings screen has to prove something is stored without handing it back:
 * `sk_live_…4242` is enough for somebody to recognise their own key, and
 * useless to anybody reading over their shoulder or through a screenshot.
 */
export function hint(plaintext: string): string {
  return plaintext.length <= 4 ? "…" : `…${plaintext.slice(-4)}`;
}

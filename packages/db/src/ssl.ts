import { readFileSync } from "node:fs";

export interface DbSslOptions {
  ca: string;
  rejectUnauthorized: true;
}

/**
 * TLS settings for the database connection.
 *
 * `sslmode=require` in a connection string encrypts but does NOT authenticate
 * the server — anything that can intercept the connection can present its own
 * certificate. Managed providers issue a private CA for exactly this reason, so
 * when `DATABASE_CA_PATH` points at one, the certificate is verified against it.
 *
 * Returns undefined when no CA is configured, which leaves the driver's own
 * handling of the connection string in place (local development over a socket
 * or plain TCP needs nothing here).
 */
export function dbSsl(
  path = process.env.DATABASE_CA_PATH,
): DbSslOptions | undefined {
  if (!path) return undefined;
  try {
    return { ca: readFileSync(path, "utf8"), rejectUnauthorized: true };
  } catch (err) {
    // Fail loudly: silently downgrading to an unverified connection is exactly
    // the outcome this function exists to prevent.
    throw new Error(
      `DATABASE_CA_PATH is set to ${path} but could not be read: ${(err as Error).message}`,
    );
  }
}

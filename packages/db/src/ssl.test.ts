import { expect, test } from "bun:test";
import { dbSsl } from "./ssl";

test("no CA configured means no ssl override", () => {
  expect(dbSsl(undefined)).toBeUndefined();
});

test("a readable CA is returned with verification ON", async () => {
  const path = `/tmp/test-ca-${crypto.randomUUID()}.crt`;
  await Bun.write(
    path,
    "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
  );
  const ssl = dbSsl(path);
  expect(ssl?.rejectUnauthorized).toBe(true);
  expect(ssl?.ca).toContain("BEGIN CERTIFICATE");
  await Bun.file(path).delete();
});

test("a missing CA throws rather than silently downgrading the connection", () => {
  // the whole point of the setting is to refuse an unverified connection
  expect(() => dbSsl("/tmp/definitely-not-here.crt")).toThrow(
    /could not be read/,
  );
});

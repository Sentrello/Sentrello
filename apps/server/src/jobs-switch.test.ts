import { expect, test } from "bun:test";

/**
 * The queue can be turned off for a process that must not do production work.
 *
 * This exists for a cutover: a second instance is stood up against the
 * database that already has one, so it can be proved working before any DNS
 * changes. The queue itself is safe under two workers — a job is claimed
 * atomically, and a scheduled job is a singleton — but a machine being tested
 * has no business sending a customer's overdue chase, and "it probably will
 * not" is not the standard to move production on.
 *
 * Read from the source rather than by booting a server, because booting one is
 * exactly the thing that would send the email.
 */
const source = await Bun.file(`${import.meta.dir}/index.ts`).text();

test("jobs are on unless something says otherwise", () => {
  // The default has to be on: an instance that serves screens and never sends
  // an overdue chase is failing at half its job, silently.
  expect(source).toContain('process.env.SENTRELLO_JOBS ?? "on"');
});

test("only the exact word off turns them off", () => {
  // Not "falsy", not "anything but on". A typo in an environment variable must
  // not quietly stop a business's invoicing.
  expect(source).toContain('.toLowerCase() !== "off"');
});

test("the queue does not start when they are off", () => {
  expect(source).toContain("if (import.meta.main && jobsEnabled) {");
});

test("a process running without them says so on startup", () => {
  // Otherwise the one instance nobody meant to leave in that state looks
  // identical to a healthy one.
  expect(source).toContain('jobsEnabled ? "" : ", jobs=off"');
});

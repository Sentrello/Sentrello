import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "@sentrello/module-sdk";

/**
 * The platform never touches a card number, and this is what keeps it that way.
 *
 * PCI DSS gets dramatically cheaper the moment a merchant stops handling
 * cardholder data at all. Taking payment by redirecting to a hosted checkout —
 * Stripe's or PayPal's own page — puts a business in **SAQ A**, the shortest
 * self-assessment there is, because the card number is never in their systems
 * to be stolen. Accepting a card number on our own form, even once, even in a
 * field nobody reads, moves every business running this platform into SAQ D:
 * hundreds of controls, quarterly scans, and a breach that is their problem.
 *
 * That is a decision worth defending automatically rather than remembering. The
 * cost of the mistake is not ours to pay and it would not be noticed by any
 * test that checks whether the payment works — because it would work.
 *
 * The provider contract is the other half: `HostedCheckout` returns a `url`,
 * which is a redirect, and there is deliberately no shape in it that could
 * carry a card.
 */
const ROOTS = [
  join(import.meta.dir, "../../../packages"),
  join(import.meta.dir, "../../web/src"),
];

/**
 * Names a card field is called when somebody adds one.
 *
 * Matched as whole words against source, not against the words in a comment
 * about card fields — this file itself would otherwise fail.
 */
const CARDHOLDER =
  /\b(card_?number|cardNum|pan_?number|cvv2?|cvc2?|security_?code|exp_?month|exp_?year|expiry_?month|expiry_?year|track_?data)\b/i;

const files = ROOTS.flatMap((root) => {
  try {
    return sourceFiles(root, [".ts", ".tsx"]);
  } catch {
    return [];
  }
}).filter(
  (f) =>
    !f.includes("/dist/") &&
    !f.includes("/node_modules/") &&
    // This file names the fields it forbids.
    !f.endsWith("pci.test.ts"),
);

test("there are source files to check", () => {
  // A glob that matches nothing passes every assertion below it.
  expect(files.length).toBeGreaterThan(100);
});

test("no card number, expiry or security code appears anywhere", () => {
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (CARDHOLDER.test(text)) {
      const line = text.split("\n").findIndex((l) => CARDHOLDER.test(l));
      offenders.push(`${file.split("/packages/")[1] ?? file}:${line + 1}`);
    }
  }
  expect(offenders).toEqual([]);
});

/**
 * Payment goes out to somebody else's page, and comes back.
 *
 * If this ever stops being true the platform is taking card details itself,
 * whatever the field is called.
 */
test("the payment contract offers a hosted page and nothing else", () => {
  const provider = readFileSync(
    join(
      import.meta.dir,
      "../../../packages/module-sdk/src/payments/provider.ts",
    ),
    "utf8",
  );
  expect(provider).toContain("HostedCheckout");
  expect(provider).toMatch(/url:\s*string/);
});

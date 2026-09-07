import { expect, test } from "bun:test";
import { qrModules } from "./qr";

/**
 * A QR code cannot be checked by reading it, so what is checked is the frame
 * around the encoder: that nothing is drawn in the quiet zone, that a longer
 * URI grows the grid rather than throwing, and that the same input gives the
 * same picture. A code with a missing quiet zone scans on the phone of
 * whoever built it and on nobody else's.
 */

const URI =
  "otpauth://totp/Sentrello:owner@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Sentrello";

test("the quiet zone is kept clear on every side", () => {
  const { span, dark } = qrModules(URI);
  expect(dark.length).toBeGreaterThan(0);
  for (const m of dark) {
    expect(m.x).toBeGreaterThanOrEqual(4);
    expect(m.y).toBeGreaterThanOrEqual(4);
    expect(m.x).toBeLessThan(span - 4);
    expect(m.y).toBeLessThan(span - 4);
  }
});

test("a longer account grows the code instead of failing", () => {
  const small = qrModules("otpauth://totp/S:a@b.c?secret=AAAA&issuer=S");
  const long = qrModules(
    `otpauth://totp/Sentrello:${"a".repeat(120)}@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Sentrello`,
  );
  expect(long.span).toBeGreaterThan(small.span);
});

test("the same URI draws the same code", () => {
  expect(qrModules(URI)).toEqual(qrModules(URI));
});

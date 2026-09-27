import { expect, test } from "bun:test";
import { plainText } from "./index";
import { invoiceEmail, overdueReminderEmail } from "./templates";

/**
 * Every message this product sends was HTML and nothing else. A self-hosted
 * business sends its invoices from its own domain with no sending reputation
 * at all, and an HTML-only message is one a spam filter marks down for being
 * HTML-only. For the message that asks to be paid, that is the inbox or the
 * junk folder.
 */
test("a real invoice message reads as words", () => {
  const { html } = invoiceEmail({
    number: "INV-0007",
    totalCents: 125000,
    currency: "USD",
    dueDate: new Date("2026-10-25T00:00:00Z"),
    portalUrl: "https://example.test/share/invoice/abc",
    business: {
      name: "Barker & Pawski",
      countryCode: "US",
      address: "14 Mill Lane",
    },
  });
  const text = plainText(html);
  expect(text).toContain("INV-0007");
  expect(text).toContain("$1,250.00");
  expect(text).toContain("25 Oct 2026");
  // The link is the point of the message; as bare words it is a dead end.
  expect(text).toContain("https://example.test/share/invoice/abc");
  expect(text).not.toContain("<");
  expect(text).not.toContain("&amp;");
  // The ampersand in the business's own name comes back as one character.
  expect(text).toContain("Barker & Pawski");
});

test("a reminder keeps its link too", () => {
  const { html } = overdueReminderEmail({
    number: "INV-0008",
    balanceDueCents: 5000,
    currency: "GBP",
    portalUrl: "https://example.test/share/invoice/def",
  });
  expect(plainText(html)).toContain("https://example.test/share/invoice/def");
});

test("a line break in the markup is a line break in the words", () => {
  expect(plainText("<p>One</p><p>Two</p>")).toBe("One\n\nTwo");
  expect(plainText("a<br>b")).toBe("a\nb");
});

/**
 * The `<head>` has to go before the tags do, or its contents survive as a
 * paragraph of nothing.
 */
test("the head does not become the first paragraph", () => {
  const text = plainText(
    '<!doctype html><html><head><meta charset="utf-8"><style>p{color:red}</style></head><body><p>Hello</p></body></html>',
  );
  expect(text).toBe("Hello");
});

/** `&amp;lt;` is the four characters somebody typed, not a tag. */
test("a double-escaped angle bracket stays four characters", () => {
  expect(plainText("<p>&amp;lt;</p>")).toBe("&lt;");
});

/**
 * The templates wrap their source at eighty columns, and a newline in
 * markup is a space. Read as a break it landed in the message: "treat
 * it⏎like a bill in the post."
 */
test("a line wrapped in the markup is one sentence in the words", () => {
  expect(plainText("<p>treat it\nlike a bill in the post.</p>")).toBe(
    "treat it like a bill in the post.",
  );
});

import { expect, test } from "bun:test";
import {
  addressOf,
  addressesOf,
  candidateAddresses,
  htmlToText,
  parseInbound,
  secretMatches,
} from "./inbound";

/**
 * The endpoint behind these functions is unauthenticated by necessity — a mail
 * provider posts to it. What is tested here is everything that stands in for a
 * session: the secret comparison, which address the message is filed against,
 * and what happens when it matches nobody.
 */

test("a secret is compared whole, and only when there is one", () => {
  expect(secretMatches("abc123", "abc123")).toBe(true);
  expect(secretMatches("abc124", "abc123")).toBe(false);
  // Capture is off until somebody turns it on, and off means nothing matches.
  expect(secretMatches("", null)).toBe(false);
  expect(secretMatches("anything", null)).toBe(false);
  // A prefix is not a match, and a different length must not throw.
  expect(secretMatches("abc", "abc123")).toBe(false);
  expect(secretMatches("abc123456", "abc123")).toBe(false);
});

test("an address is pulled out of whatever the header looked like", () => {
  expect(addressOf("Dave Nunn <Dave@Example.com>")).toBe("dave@example.com");
  expect(addressOf("  dave@example.com ")).toBe("dave@example.com");
  expect(addressOf("not an address")).toBeNull();
  expect(addressOf("dave@localhost")).toBeNull();
  expect(addressOf(undefined)).toBeNull();
});

test("a header with several addresses gives all of them", () => {
  expect(addressesOf("a@x.com, Bee <b@y.com>, rubbish")).toEqual([
    "a@x.com",
    "b@y.com",
  ]);
  // Postmark sends objects rather than a string.
  expect(addressesOf([{ Email: "c@z.com" }, { email: "d@z.com" }])).toEqual([
    "c@z.com",
    "d@z.com",
  ]);
});

test("a message is read whichever provider posted it", () => {
  const postmark = parseInbound({
    From: "Dave Nunn <dave@example.com>",
    To: "sales@ours.test",
    Cc: "capture@ours.test",
    Subject: "Re: the quote",
    TextBody: "Looks fine, go ahead.",
  });
  expect(postmark.from).toBe("dave@example.com");
  expect(postmark.recipients).toEqual(["sales@ours.test", "capture@ours.test"]);
  expect(postmark.subject).toBe("Re: the quote");
  expect(postmark.body).toBe("Looks fine, go ahead.");

  const mailgun = parseInbound({
    from: "dave@example.com",
    to: "capture@ours.test",
    subject: "Hello",
    "body-plain": "Morning.",
  });
  expect(mailgun.body).toBe("Morning.");
});

test("a message with only HTML still reads as a sentence", () => {
  const message = parseInbound({
    from: "dave@example.com",
    subject: "Quote",
    HtmlBody:
      "<style>p{color:red}</style><p>Morning,</p><p>The <b>price</b> is fine.</p>",
  });
  expect(message.body).toBe("Morning,\nThe price is fine.");
  expect(message.body).not.toContain("color:red");
});

test("the business's own capture address is never the customer", () => {
  // The business CCs itself on mail it sends. Filing that against itself would
  // file every outgoing conversation against nobody.
  const message = parseInbound({
    From: "us@ours.test",
    To: "dave@example.com",
    Cc: "capture@ours.test",
    Subject: "Your quote",
    TextBody: "Attached.",
  });
  expect(candidateAddresses(message, "capture@ours.test")).toEqual([
    "us@ours.test",
    "dave@example.com",
  ]);
  expect(candidateAddresses(message, "CAPTURE@ours.test")).not.toContain(
    "capture@ours.test",
  );
});

test("an attachment with no content is not an attachment", () => {
  const message = parseInbound({
    from: "dave@example.com",
    subject: "Photos",
    Attachments: [
      { Name: "damp.jpg", ContentType: "image/jpeg", Content: "AAAA" },
      { Name: "empty.pdf", ContentType: "application/pdf", Content: "" },
    ],
  });
  expect(message.attachments).toHaveLength(1);
  expect(message.attachments[0]?.name).toBe("damp.jpg");
});

test("a body longer than the cap is cut rather than stored whole", () => {
  const message = parseInbound({
    from: "dave@example.com",
    text: "x".repeat(400_000),
  });
  expect(message.body.length).toBe(256 * 1024);
});

test("markup in a body is text, and stays text", () => {
  // Notes are rendered as text, never as HTML, but the stored string should
  // not carry markup either — it ends up in an export, an email, a PDF.
  expect(htmlToText("<p>Hi <script>alert(1)</script>there</p>")).toBe(
    "Hi there",
  );
});

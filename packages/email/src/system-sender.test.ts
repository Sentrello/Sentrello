import { afterEach, expect, test } from "bun:test";
import { systemFrom, systemReplyTo } from "./index";

/**
 * The platform's own mail, and the business's, are not the same letter.
 *
 * A business's invoice comes from that business and a customer replying to it
 * has to reach a person — it is the one message where a reply is the point.
 * A password reset is the opposite: nobody should reply, and on a hosted
 * instance a reply lands in whichever inbox owns the sending address rather
 * than with anybody who reads support mail.
 *
 * Both settings are optional, and an instance that sets neither has to behave
 * exactly as it did before they existed. That is most self-hosted instances,
 * and it is the case worth pinning.
 */
const saved = {
  from: process.env.EMAIL_FROM,
  system: process.env.EMAIL_SYSTEM_FROM,
  replyTo: process.env.EMAIL_REPLY_TO,
};

afterEach(() => {
  for (const [key, value] of [
    ["EMAIL_FROM", saved.from],
    ["EMAIL_SYSTEM_FROM", saved.system],
    ["EMAIL_REPLY_TO", saved.replyTo],
  ] as const) {
    // `process.env[key] = undefined` stores the string "undefined", which is
    // a sender address as far as everything downstream is concerned.
    if (value === undefined) process.env[key] = "";
    else process.env[key] = value;
  }
});

test("with nothing set, the platform writes as the business does", () => {
  process.env.EMAIL_FROM = "A Business <billing@abusiness.test>";
  process.env.EMAIL_SYSTEM_FROM = "";
  expect(systemFrom()).toBe("A Business <billing@abusiness.test>");
});

test("a system sender is used for the platform's own mail only", () => {
  process.env.EMAIL_FROM = "A Business <billing@abusiness.test>";
  process.env.EMAIL_SYSTEM_FROM = "Sentrello <no-reply@sentrello.com>";
  expect(systemFrom()).toBe("Sentrello <no-reply@sentrello.com>");
});

test("no reply-to header at all unless an address is set", () => {
  process.env.EMAIL_REPLY_TO = "";
  expect(systemReplyTo()).toEqual({});
  process.env.EMAIL_REPLY_TO = "support@sentrello.com";
  expect(systemReplyTo()).toEqual({ "reply-to": "support@sentrello.com" });
});

/**
 * A blank value is not an address.
 *
 * `EMAIL_REPLY_TO=` in an env file reads as an empty string, and a `reply-to`
 * header with nothing in it is a malformed message some servers reject
 * outright — which would take password resets down rather than degrade them.
 */
test("a blank setting is no setting", () => {
  process.env.EMAIL_REPLY_TO = "   ";
  expect(systemReplyTo()).toEqual({});
});

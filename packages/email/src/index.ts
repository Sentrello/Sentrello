import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  from?: string;
  /**
   * Extra headers, for the ones that change how a message is treated rather
   * than what it says.
   *
   * `List-Unsubscribe` is why this exists: Gmail and Outlook show a one-click
   * unsubscribe when it is present and weigh its absence against a sender's
   * reputation, so a bulk sender without it is a bulk sender whose mail
   * gradually stops arriving.
   */
  headers?: Record<string, string>;
}

/**
 * A header a stranger wrote, on its way into somebody's mail server.
 *
 * A carriage return or a newline inside a header value ends that header and
 * begins another — the oldest trick in SMTP. It matters here because one of
 * these headers is not ours: the CRM's public form puts whatever address a
 * visitor typed into `Reply-To`, so that hitting reply on an enquiry writes
 * back to the person who sent it. The check at that call site is that the
 * string contains an `@`, which `me@example.com\r\nBcc: everyone@…` passes.
 *
 * Both adapters hand `headers` straight to somebody else — Resend as JSON,
 * nodemailer to its own encoder — and both of them probably cope. "Probably
 * cope" is not a thing to build a public endpoint on, and the fix belongs
 * here rather than at each caller: every message in the product goes through
 * this one door, and the next caller to trust its input will not read this
 * comment.
 *
 * Dropped rather than stripped. A header value with a newline in it is not a
 * header anybody meant to send, and quietly delivering the first half of
 * somebody's attempt is worse than delivering none of it.
 */
function safeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      console.error(
        `[email] dropped a header with a line break in it: ${name}`,
      );
      continue;
    }
    clean[name] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * The subject is a header too, and the same trick works on it.
 *
 * Every subject in the product is written by the product, so this is the belt
 * rather than the braces — but a subject carrying a form's own name is one
 * template away, and that name comes from whoever set the form up.
 */
function safeSubject(subject: string): string {
  return subject.replace(/[\r\n]+/g, " ").trim();
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}

class ResendAdapter implements EmailAdapter {
  constructor(
    private key: string,
    private from: string,
  ) {}

  async send(m: EmailMessage) {
    const headers = safeHeaders(m.headers);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: m.from ?? this.from,
        to: m.to,
        subject: safeSubject(m.subject),
        html: m.html,
        ...(headers ? { headers } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status} ${await res.text()}`);
    }
  }
}

class SmtpAdapter implements EmailAdapter {
  private transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  async send(m: EmailMessage) {
    const headers = safeHeaders(m.headers);
    await this.transport.sendMail({
      from: m.from ?? process.env.EMAIL_FROM,
      to: m.to,
      subject: safeSubject(m.subject),
      html: m.html,
      ...(headers ? { headers } : {}),
    });
  }
}

/**
 * A mail server somebody configured, rather than the one in the environment.
 *
 * Bulk marketing and transactional mail want different senders — a campaign
 * that draws complaints must not damage the reputation carrying password
 * resets — so a module can send through a server of its own. The library stays
 * here rather than being installed a second time in the module, because two
 * copies of a mail client is two places for a business's mail to break.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  ignoreTLS?: boolean;
  /** The HELO name, where a server insists on a fully qualified one. */
  name?: string;
  auth?: { user: string; pass: string };
  pool?: boolean;
  maxConnections?: number;
  connectionTimeout?: number;
  socketTimeout?: number;
  tls?: { rejectUnauthorized: boolean };
}

export function smtpAdapter(config: SmtpConfig): EmailAdapter {
  const transport = nodemailer.createTransport(config);
  return {
    async send(m: EmailMessage) {
      await transport.sendMail({
        from: m.from ?? process.env.EMAIL_FROM,
        to: m.to,
        subject: m.subject,
        html: m.html,
        ...(m.headers ? { headers: m.headers } : {}),
      });
    },
  };
}

/**
 * Whether a configured server actually answers, before anything depends on it.
 *
 * The whole reason a connection is set on a screen rather than in a file:
 * somebody finds out they typed the password wrong now, rather than when
 * eleven thousand messages fail to go.
 *
 * Throws with the provider's own words. "authentication failed" and
 * "connection refused" send somebody to two different places, and a single
 * "could not connect" sends them to neither.
 */
export async function verifySmtp(config: SmtpConfig): Promise<void> {
  await nodemailer.createTransport(config).verify();
}

/** No mail configured: log instead of throwing, so jobs never crash a boot. */
class NoopAdapter implements EmailAdapter {
  async send(m: EmailMessage) {
    console.warn(`[email] no adapter configured, dropping mail to ${m.to}`);
  }
}

/**
 * Whether this instance can actually send mail.
 *
 * A self-hosted instance may have no mail configured at all, and a password
 * reset that silently posts into a NoopAdapter would leave the only
 * administrator locked out with a screen telling them to check their inbox.
 * The sign-in page asks this so it can offer the truth instead.
 */
export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_HOST);
}

/**
 * Who the platform itself writes as, which is not who the business writes as.
 *
 * Two kinds of mail leave an instance and they want opposite things.
 *
 * A business's own mail — an invoice, a quote, a booking confirmation — comes
 * from that business, and a customer replying to it must reach a person. A
 * no-reply invoice is a customer holding a question about money with nowhere
 * to put it, and it is the one message where a reply is the point.
 *
 * The platform's own mail is the other case. A password reset, an address
 * confirmation, an invitation: nobody should reply to these, and on a hosted
 * instance a reply lands in whichever inbox happens to own the sending
 * address rather than with support. So they are sent from `EMAIL_SYSTEM_FROM`
 * where one is set, and `EMAIL_REPLY_TO` points anybody who replies anyway at
 * an address that is read.
 *
 * Both are optional and both fall back to `EMAIL_FROM`, so an instance that
 * sets neither behaves exactly as it did — which is every self-hosted
 * instance until its owner decides otherwise.
 */
export function systemFrom(): string | undefined {
  // Empty is unset. `EMAIL_SYSTEM_FROM=` in an env file is a blank string,
  // and a blank From is a message every mail server refuses.
  return process.env.EMAIL_SYSTEM_FROM?.trim() || process.env.EMAIL_FROM;
}

/** Where a reply to the platform's own mail should go, if anywhere. */
export function systemReplyTo(): Record<string, string> {
  const to = process.env.EMAIL_REPLY_TO?.trim();
  return to ? { "reply-to": to } : {};
}

export function emailAdapter(): EmailAdapter {
  if (process.env.RESEND_API_KEY) {
    return new ResendAdapter(
      process.env.RESEND_API_KEY,
      process.env.EMAIL_FROM ?? "sentrello@localhost",
    );
  }
  if (process.env.SMTP_HOST) return new SmtpAdapter();
  return new NoopAdapter();
}

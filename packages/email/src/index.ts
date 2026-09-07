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

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}

class ResendAdapter implements EmailAdapter {
  constructor(
    private key: string,
    private from: string,
  ) {}

  async send(m: EmailMessage) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: m.from ?? this.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
        ...(m.headers ? { headers: m.headers } : {}),
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
    await this.transport.sendMail({
      from: m.from ?? process.env.EMAIL_FROM,
      to: m.to,
      subject: m.subject,
      html: m.html,
      ...(m.headers ? { headers: m.headers } : {}),
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

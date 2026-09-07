import { timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { rateLimit } from "@sentrello/module-sdk";
import { displayFilename, safeExtension } from "./attachments";

/**
 * Email that files itself.
 *
 * The reference product's best idea: a business CCs one address on the mail it
 * was already sending, and the message lands on the customer's record as a
 * note. Nobody has to remember to copy a conversation into the CRM, which is
 * the reason CRMs are full of contacts nobody has spoken to for a year.
 *
 * The endpoint is unauthenticated by necessity — a mail provider posts to it,
 * and it holds no session. What stands in for one:
 *
 *  - the organization is named in the URL and the secret is compared in
 *    constant time, so the address cannot be guessed a character at a time;
 *  - it is off until somebody turns it on, and rotating the secret revokes
 *    every provider still posting with the old one;
 *  - a message that matches nobody is dropped rather than filed against a
 *    guess, and answered 200 so the provider does not retry for ever;
 *  - bodies and attachments are capped, because this is a door onto disk.
 */

const attachmentsDir = () =>
  join(resolve(process.env.SENTRELLO_DATA_DIR ?? "/data"), "attachments");

/** What one message may bring with it. */
export const MAX_INBOUND_BODY = 256 * 1024;
export const MAX_INBOUND_ATTACHMENT = 10 * 1024 * 1024;
export const MAX_INBOUND_ATTACHMENTS = 10;

/**
 * Comparing the secret without leaking it.
 *
 * `===` on strings stops at the first differing byte, which is a timing signal
 * somebody can walk. Different lengths are rejected first because
 * timingSafeEqual throws on them.
 */
export function secretMatches(given: string, stored: string | null): boolean {
  if (!stored) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The address out of "Dave Nunn <dave@example.com>", lowercased. */
export function addressOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const angled = value.match(/<([^>]+)>/);
  const raw = (angled?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

/** Every address in a header that may hold several. */
export function addressesOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      typeof entry === "string"
        ? (addressOf(entry) ?? [])
        : (addressOf(
            (entry as { Email?: string; email?: string })?.Email ??
              (entry as { email?: string })?.email,
          ) ?? []),
    );
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((part) => addressOf(part))
    .filter((a): a is string => a !== null);
}

/**
 * Markup to something readable.
 *
 * Only used when a message has no plain-text part. It is not a sanitiser —
 * nothing here is ever rendered as HTML — it is what turns a marketing
 * template into a sentence somebody can read in a note.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, " ")
      // A tag boundary leaves a space against the line break; without this the
      // note reads as though every paragraph were indented.
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export interface InboundMessage {
  from: string | null;
  recipients: string[];
  subject: string;
  body: string;
  attachments: { name: string; type: string; content: string }[];
}

/**
 * One message, whatever posted it.
 *
 * Postmark capitalises its fields, SendGrid and Mailgun do not, and a business
 * forwarding by hand from a script sends whatever it likes. Reading both
 * spellings costs a few lines and saves a provider-specific endpoint per
 * provider.
 */
export function parseInbound(payload: Record<string, unknown>): InboundMessage {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = payload[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  };

  const html = pick("HtmlBody", "html", "body-html");
  const text = pick("TextBody", "text", "body-plain", "plain");
  const body =
    typeof text === "string"
      ? text
      : typeof html === "string"
        ? htmlToText(html)
        : "";

  const raw = pick("attachments", "Attachments");
  const attachments = Array.isArray(raw)
    ? raw
        .slice(0, MAX_INBOUND_ATTACHMENTS)
        .map((a) => {
          const entry = a as Record<string, unknown>;
          const content = entry.Content ?? entry.content ?? entry.data;
          return {
            name: String(entry.Name ?? entry.name ?? "attachment"),
            type: String(
              entry.ContentType ?? entry.contentType ?? entry.type ?? "",
            ),
            content: typeof content === "string" ? content : "",
          };
        })
        .filter((a) => a.content !== "")
    : [];

  return {
    from: addressOf(pick("From", "from", "sender", "FromFull")),
    recipients: [
      ...addressesOf(pick("To", "to", "ToFull")),
      ...addressesOf(pick("Cc", "cc", "CcFull")),
    ],
    subject: String(pick("Subject", "subject") ?? "").slice(0, 200),
    body: body.slice(0, MAX_INBOUND_BODY),
    attachments,
  };
}

/**
 * Which address on the message is the customer's.
 *
 * The sender when the customer wrote in, and otherwise whichever recipient is
 * not the business's own capture address — the business CCs itself on mail it
 * sends, and filing that against itself would be filing every conversation
 * against nobody.
 */
export function candidateAddresses(
  message: InboundMessage,
  inboundAddress: string | null,
): string[] {
  const own = inboundAddress?.toLowerCase() ?? null;
  const all = [message.from, ...message.recipients].filter(
    (a): a is string => a !== null && a !== own,
  );
  return [...new Set(all)];
}

export function registerInboundEmail(ctx: ModuleContext) {
  /** What the settings screen shows: whether it is on, and where to CC. */
  ctx.app.get(
    "/api/crm/inbound",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .select()
        .from(schema.crmSettings)
        .where(eq(schema.crmSettings.organizationId, orgId))
        .limit(1);

      const base = process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
      return c.json({
        enabled: Boolean(row?.inboundSecret),
        address: row?.inboundAddress ?? null,
        // The whole credential, shown to somebody who can already change it.
        webhookUrl: row?.inboundSecret
          ? `${base}/api/crm/inbound-email/${orgId}/${row.inboundSecret}`
          : null,
      });
    },
  );

  /** Turning it on, or rotating the secret, which revokes the old URL. */
  ctx.app.post(
    "/api/crm/inbound",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        address?: unknown;
      };
      const address = addressOf(body.address);

      const secret = crypto.randomUUID().replaceAll("-", "");
      await db
        .insert(schema.crmSettings)
        .values({
          organizationId: orgId,
          inboundSecret: secret,
          inboundAddress: address,
        })
        .onConflictDoUpdate({
          target: schema.crmSettings.organizationId,
          set: {
            inboundSecret: secret,
            inboundAddress: address,
            updatedAt: new Date(),
          },
        });

      const base = process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
      return c.json({
        enabled: true,
        address,
        webhookUrl: `${base}/api/crm/inbound-email/${orgId}/${secret}`,
      });
    },
  );

  /** Turning it off. Anything still posting stops being able to. */
  ctx.app.delete(
    "/api/crm/inbound",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      await db
        .update(schema.crmSettings)
        .set({ inboundSecret: null, updatedAt: new Date() })
        .where(eq(schema.crmSettings.organizationId, orgId));
      return c.json({ enabled: false });
    },
  );

  ctx.app.post(
    "/api/crm/inbound-email/:orgId/:secret",
    async (c: RouteContext) => {
      const limited = rateLimit(
        `inbound:${c.req.header("x-real-ip") ?? "anon"}`,
        120,
        60_000,
      );
      if (!limited.allowed) return c.text("Too many requests", 429);

      const orgId = c.req.param("orgId") ?? "";
      const [settings] = await db
        .select()
        .from(schema.crmSettings)
        .where(eq(schema.crmSettings.organizationId, orgId))
        .limit(1);

      // The same answer whether the organization exists, the feature is off,
      // or the secret is wrong.
      if (
        !secretMatches(
          c.req.param("secret") ?? "",
          settings?.inboundSecret ?? null,
        )
      ) {
        return c.json({ error: "not found" }, 404);
      }

      const payload = (await c.req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!payload) return c.json({ error: "unreadable" }, 400);

      const message = parseInbound(payload);
      const addresses = candidateAddresses(
        message,
        settings?.inboundAddress ?? null,
      );
      if (addresses.length === 0) return c.json({ matched: false });

      const contacts = await db
        .select({ id: schema.contacts.id, email: schema.contacts.email })
        .from(schema.contacts)
        .where(eq(schema.contacts.organizationId, orgId));

      const wanted = new Set(addresses);
      const contact = contacts.find(
        (row) => row.email && wanted.has(row.email.toLowerCase()),
      );
      /**
       * Nobody matched, so nothing is written.
       *
       * Filing it against a guess is worse than dropping it: a private
       * conversation on the wrong customer's record is a data breach with a
       * paper trail. 200 rather than 404 because the provider is not at
       * fault and should not retry.
       */
      if (!contact) return c.json({ matched: false });

      const attachments: {
        name: string;
        path: string;
        size: number;
        type: string;
      }[] = [];
      for (const file of message.attachments) {
        const bytes = Buffer.from(file.content, "base64");
        if (bytes.length === 0 || bytes.length > MAX_INBOUND_ATTACHMENT) {
          continue;
        }
        // Generated name, as everywhere else: nothing a sender chose ever
        // reaches the filesystem.
        const stored = `${crypto.randomUUID()}${safeExtension(file.name)}`;
        const dir = join(attachmentsDir(), orgId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, stored), bytes, { mode: 0o600 });
        attachments.push({
          name: displayFilename(file.name),
          path: `${orgId}/${stored}`,
          size: bytes.length,
          type: file.type || "application/octet-stream",
        });
      }

      const text = [message.subject, message.body]
        .filter((part) => part !== "")
        .join("\n\n");

      const [note] = await db
        .insert(schema.notes)
        .values({
          organizationId: orgId,
          entityType: "contact",
          entityId: contact.id,
          text: text || "(an email with no subject or body)",
          attachments,
        })
        .returning();

      // And on the timeline, so the contact's history shows the conversation
      // rather than only the note body.
      await db.insert(schema.activities).values({
        organizationId: orgId,
        contactId: contact.id,
        type: "email",
        body: message.subject || "Email",
        occurredAt: new Date(),
      });

      return c.json({ matched: true, noteId: note?.id });
    },
  );
}

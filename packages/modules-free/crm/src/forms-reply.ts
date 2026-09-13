/**
 * What a visitor sees after posting a form.
 *
 * The snippet this module hands a business is deliberately plain HTML that
 * needs no JavaScript, so most people who use it arrive here by ordinary form
 * navigation — and until now they landed on raw JSON. Worse, a business that
 * set a redirect URL got it back as a field in that JSON rather than as a
 * redirect, so the setting did nothing for exactly the visitors the snippet
 * was built for.
 *
 * The `accept` header separates the two callers: a browser navigating a form
 * asks for text/html, `fetch` does not.
 */
import type { Context } from "hono";

/** True when the caller is a browser following a form post, not a script. */
export function wantsHtml(c: Context): boolean {
  return (c.req.header("accept") ?? "").includes("text/html");
}

/**
 * Escaped for HTML.
 *
 * Exported because the notification mail needs it too, and a second copy is a
 * second place to forget an entity — this is what stands between a form field
 * somebody typed and the markup of a page or a message.
 */
export const html = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] ?? ch,
  );

/**
 * What a visitor is told about the software underneath, at the foot.
 *
 * A Free instance carries "Powered by Sentrello" on every page a visitor
 * reaches — that is part of what Free is, and it is the only place most people
 * will ever see the name. Pro is paid for: a paying business puts its own
 * credit there, or none at all.
 *
 * Opens in a new tab, because the visitor was in the middle of contacting
 * somebody and the page they are on is the receipt for it.
 */
export interface Credit {
  text: string;
  url: string | null;
}

/** The credit a Free instance always shows. */
export const SENTRELLO_CREDIT: Credit = {
  text: "Powered by Sentrello",
  url: "https://sentrello.com",
};

function creditFooter(credit: Credit | null): string {
  if (!credit || !credit.text.trim()) return "";
  const label = html(credit.text.trim());
  const body = credit.url
    ? `<a href="${html(credit.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
  return `<p class="credit">${body}</p>`;
}

function page(
  title: string,
  heading: string,
  body: string,
  credit: Credit | null = null,
): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(title)}</title>
<style>
:root { color-scheme: light dark; --ink:#1a1a1a; --muted:#666; --bg:#fff; }
@media (prefers-color-scheme: dark) {
  :root { --ink:#f4f4f5; --muted:#a1a1aa; --bg:#131313; }
}
body { font:16px/1.6 system-ui,-apple-system,sans-serif; color:var(--ink);
  background:var(--bg); margin:0; padding:4rem 1.5rem; }
main { max-width:32rem; margin:0 auto; }
h1 { font-size:1.375rem; margin:0 0 .5rem; }
p { color:var(--muted); margin:0; }
.credit { margin-top:2rem; font-size:.8125rem; }
.credit a { color:var(--muted); }
</style>
</head><body><main><h1>${html(heading)}</h1><p>${html(body)}</p>${creditFooter(credit)}</main></body></html>`;
}

/**
 * The fallback thank-you, for a business that has not set a redirect.
 *
 * Named after the form so the visitor can see which message went through —
 * the same page can be reached from a quote request and a contact form.
 */
export function thanksPage(
  formName: string,
  businessName: string,
  credit: Credit | null = SENTRELLO_CREDIT,
): string {
  return page(
    `Thank you — ${businessName}`,
    "Thanks — we have got that",
    `Your ${formName.toLowerCase()} has reached ${businessName}. Someone will be in touch.`,
    credit,
  );
}

/** Something went wrong, said in a sentence rather than a status code. */
export function problemPage(message: string): string {
  return page("That did not send", "That did not send", message);
}

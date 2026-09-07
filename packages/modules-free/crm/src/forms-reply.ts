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

function page(title: string, heading: string, body: string): string {
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
</style>
</head><body><main><h1>${html(heading)}</h1><p>${html(body)}</p></main></body></html>`;
}

/**
 * The fallback thank-you, for a business that has not set a redirect.
 *
 * Named after the form so the visitor can see which message went through —
 * the same page can be reached from a quote request and a contact form.
 */
export function thanksPage(formName: string, businessName: string): string {
  return page(
    `Thank you — ${businessName}`,
    "Thanks — we have got that",
    `Your ${formName.toLowerCase()} has reached ${businessName}. Someone will be in touch.`,
  );
}

/** Something went wrong, said in a sentence rather than a status code. */
export function problemPage(message: string): string {
  return page("That did not send", "That did not send", message);
}

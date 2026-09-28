import { useEffect, useState } from "react";
import { muted } from "./ui";

/**
 * The "Powered by Sentrello" line on pages a visitor sees before signing in.
 *
 * The server decides whose line it is — Sentrello's on Free, the business's
 * own or none on Pro — and `/api/_signin` carries the answer, because it is
 * the one endpoint these pages may read without a session. This component
 * starts from our line and only moves off it when the server explicitly says
 * so: a fetch that fails, an old server without the field, a response that
 * cannot be read — every one of those leaves the branding standing. An error
 * must never be the thing that removes it.
 */

export interface Credit {
  text: string;
  url: string | null;
}

export const SENTRELLO_CREDIT: Credit = {
  text: "Powered by Sentrello",
  url: "https://sentrello.com",
};

/** The line itself. Null renders nothing — a Pro business that removed it. */
export function CreditLine({ credit }: { credit: Credit | null }) {
  if (!credit || !credit.text.trim()) return null;
  /*
   * The class goes on the link, not on the paragraph.
   *
   * `.link-muted` carries `display: inline-flex` and a 24px minimum, because
   * it exists for the Edit and Remove links at the end of a table row. On a
   * `<p>` it makes the paragraph inline too — so this line and the source-code
   * line below it sat flush against each other on the sign-in page, reading
   * "Powered by SentrelloSource code". Two lines, one word.
   */
  return (
    <p className="mt-6 text-center text-xs" style={muted}>
      {credit.url ? (
        <a
          className="link-muted"
          href={credit.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {credit.text}
        </a>
      ) : (
        credit.text
      )}
    </p>
  );
}

/** The line below a sign-in form, asking the server whose it is. */
export function PageCredit() {
  const [credit, setCredit] = useState<Credit | null>(SENTRELLO_CREDIT);

  useEffect(() => {
    fetch("/api/_signin")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { credit?: Credit | null } | null) => {
        // Only an explicit answer moves the line; absence is not removal.
        if (body && body.credit !== undefined) setCredit(body.credit);
      })
      .catch(() => {});
  }, []);

  return <CreditLine credit={credit} />;
}

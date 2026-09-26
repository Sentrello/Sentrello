/**
 * Saying something to whoever is listening rather than looking.
 *
 * WCAG 4.1.3 asks that a status message reach somebody who cannot see it
 * appear. The obvious way is a live region in the component that has the
 * news — and for a list that would mean the same three lines in every
 * screen in the product, thirty-odd of them, each free to forget.
 *
 * So there is one region, made when it is first needed, and a function to
 * put words in it. The region is empty until then: one that already holds
 * its text when it appears announces nothing, because what a screen reader
 * speaks is the change.
 */
let region: HTMLElement | null = null;

function live(): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement("div");
  region.setAttribute("aria-live", "polite");
  // Not `aria-atomic`: the region holds one sentence at a time, and the
  // default reads what changed, which is that sentence.
  region.className = "sr-only";
  document.body.append(region);
  return region;
}

export function announce(text: string): void {
  if (typeof document === "undefined") return;
  const el = live();
  /*
   * The same words twice are silence.
   *
   * Filter to three results, clear it, filter to three again — the text is
   * identical, nothing changed, and nothing is said, which is wrong: it
   * happened twice. A trailing space makes it a different string and reads
   * the same out loud.
   */
  el.textContent = el.textContent === text ? `${text} ` : text;
}

/** For tests, which need the region gone between them. */
export function resetAnnouncer(): void {
  region?.remove();
  region = null;
}

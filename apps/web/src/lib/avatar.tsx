import { useState } from "react";

/**
 * A picture where there is one, initials where there is not.
 *
 * Every list in the CRM shows one of these, and most records have no picture —
 * so the fallback is the common case and has to look deliberate rather than
 * broken. Initials on a colour derived from the name give a page of contacts
 * some shape to scan, which is the whole reason the reference's lists read as
 * quickly as they do.
 */

/**
 * The same name always gets the same colour, and it never depends on where the
 * record sits in a list — sorting a table must not repaint everybody.
 *
 * Hues only, at a fixed saturation and lightness, so nothing lands on
 * something unreadable or clashing with the accent.
 */
function hue(name: string): number {
  let total = 0;
  for (let i = 0; i < name.length; i += 1) {
    total = (total * 31 + name.charCodeAt(i)) % 360;
  }
  return total;
}

/** "Acme Roofing Ltd" → "AR"; "Jo" → "J". Two letters at most. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export function Avatar({
  src,
  name,
  size = 40,
  rounded = "full",
}: {
  /** Where the picture would be. It is fetched, and quietly absent if there is none. */
  src?: string | null;
  name: string;
  size?: number;
  /** Companies read better as a rounded square; people as a circle. */
  rounded?: "full" | "md";
}) {
  /**
   * The initials are drawn first and always, with the picture laid over them
   * once it has actually loaded.
   *
   * The first version rendered the `<img>` alone and swapped to initials on
   * `onError`. Most records have no picture, so most rows spent a round trip
   * showing an empty box the width of an avatar — a column of holes down the
   * side of every list until the 404s came back. Initials underneath means
   * the row is right immediately and only improves.
   */
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const shape = rounded === "full" ? "9999px" : "0.5rem";
  const tint = hue(name);

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: shape,
        fontSize: Math.max(11, Math.round(size * 0.38)),
        background: `oklch(0.92 0.04 ${tint})`,
        color: `oklch(0.42 0.09 ${tint})`,
      }}
    >
      <span aria-hidden="true">{initials(name)}</span>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="absolute inset-0 object-cover"
          style={{
            width: size,
            height: size,
            borderRadius: shape,
            opacity: loaded ? 1 : 0,
          }}
        />
      ) : null}
    </span>
  );
}

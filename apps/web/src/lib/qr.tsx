import qrcode from "qrcode-generator";

/**
 * A QR code, drawn as SVG rectangles.
 *
 * The library can hand back a ready-made `<svg>` string, which would then need
 * `dangerouslySetInnerHTML` to render. Reading the modules out and drawing
 * them here is barely longer and puts no markup from a library into the page —
 * worth the few lines on a screen that exists to set up a second factor.
 *
 * Error correction "M": the middle setting, which tolerates a phone camera at
 * an angle without making the code so dense that a laptop screen at normal
 * brightness cannot be read at all.
 */
/** Four modules of quiet zone: without it many scanners never see the code. */
const QUIET = 4;

/**
 * The dark squares and the size of the grid they sit in.
 *
 * Separated from the component so the part with arithmetic in it can be
 * checked without a browser.
 */
export function qrModules(value: string): {
  span: number;
  dark: { x: number; y: number }[];
} {
  // Type 0 lets the library pick the smallest version that fits, so a longer
  // account name grows the code rather than throwing.
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const dark: { x: number; y: number }[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) dark.push({ x: col + QUIET, y: row + QUIET });
    }
  }
  return { span: count + QUIET * 2, dark };
}

export function QrCode({
  value,
  size = 180,
  label,
}: {
  value: string;
  size?: number;
  label: string;
}) {
  const { span, dark } = qrModules(value);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      {/* Always white behind the code, in both themes. A dark background with
          light modules is a code most scanners refuse. */}
      <rect width={span} height={span} fill="#ffffff" />
      {dark.map((m) => (
        <rect
          key={`${m.x}-${m.y}`}
          x={m.x}
          y={m.y}
          width={1}
          height={1}
          fill="#000000"
        />
      ))}
    </svg>
  );
}

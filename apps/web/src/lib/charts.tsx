import { muted } from "./ui";

/**
 * Two charts, drawn by hand.
 *
 * A charting library is several hundred kilobytes and a dependency in a public
 * repo, for what a business dashboard actually needs: bars of one series and a
 * line of another. Both are a few dozen lines of SVG, they scale with the box
 * they are given, and nothing here has to be kept in step with anyone's major
 * version.
 *
 * Both take pre-formatted labels rather than formatting money themselves —
 * currency belongs to the caller, and a chart that assumes dollars is wrong on
 * the first instance that does not use them.
 */

export interface Point {
  label: string;
  value: number;
  /** What to show when read, e.g. "$1,240.00". Falls back to the number. */
  display?: string;
}

/** A tidy upper bound, so the axis does not read 1,237. */
function ceiling(values: number[]): number {
  const max = Math.max(0, ...values);
  if (max === 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / magnitude) * magnitude;
}

export function Bars({
  points,
  height = 140,
}: {
  points: Point[];
  height?: number;
}) {
  if (points.length === 0) {
    return (
      <p className="text-sm" style={muted}>
        Nothing to chart yet.
      </p>
    );
  }
  const top = ceiling(points.map((p) => p.value));

  return (
    <div>
      <div
        className="flex items-end gap-1"
        style={{ height }}
        role="img"
        aria-label={points
          .map((p) => `${p.label}: ${p.display ?? p.value}`)
          .join(", ")}
      >
        {points.map((p) => (
          <div
            key={p.label}
            className="flex flex-1 flex-col justify-end"
            // Native title: a hover readout that needs no tooltip library and
            // still works for somebody using a keyboard or a screen reader.
            title={`${p.label}: ${p.display ?? p.value}`}
          >
            <div
              className="rounded-t"
              style={{
                // Always at least a hairline: a bar of zero height reads as a
                // missing month rather than an empty one.
                height: `${Math.max(2, (Math.max(0, p.value) / top) * 100)}%`,
                background: "var(--color-brand-500)",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-[10px]" style={muted}>
        {points.map((p) => (
          <div key={p.label} className="flex-1 truncate text-center">
            {p.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Line({
  points,
  height = 140,
}: {
  points: Point[];
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <p className="text-sm" style={muted}>
        Not enough history to draw a trend yet.
      </p>
    );
  }

  // A fixed viewBox with preserveAspectRatio off: the SVG stretches to the
  // card it is in, so the chart is responsive without measuring anything.
  const W = 100;
  const H = 40;
  const values = points.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(...values, min + 1);
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / (max - min)) * H;
  const path = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height }}
        role="img"
        aria-label={points
          .map((p) => `${p.label}: ${p.display ?? p.value}`)
          .join(", ")}
      >
        {/* Zero line, when the series crosses it. A loss below the axis and a
            profit above it is the whole point of the chart. */}
        {min < 0 ? (
          <line
            x1="0"
            x2={W}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--border)"
            strokeWidth="0.4"
          />
        ) : null}
        <polyline
          points={path}
          fill="none"
          stroke="var(--color-brand-500)"
          strokeWidth="0.8"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between text-[10px]" style={muted}>
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/**
 * Two series against each other, month by month.
 *
 * Won and lost, side by side, sharing one scale so the bars are comparable —
 * two charts with independent axes would make a bad month look like a good
 * one. Green up, red down is the obvious reading and the one Atomic uses.
 */
export interface PairedPoint {
  label: string;
  up: number;
  down: number;
  /** What to show when read, e.g. "won $4,200 · lost $900". */
  display?: string;
}

export function PairedBars({
  points,
  height = 140,
  upLabel,
  downLabel,
}: {
  points: PairedPoint[];
  height?: number;
  upLabel: string;
  downLabel: string;
}) {
  if (points.length === 0) {
    return (
      <p className="text-sm" style={muted}>
        Nothing to chart yet.
      </p>
    );
  }

  // One scale across both series, and across every month.
  const top = ceiling(points.flatMap((p) => [p.up, p.down]));

  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-xs" style={muted}>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-2 rounded-sm"
            style={{ background: "var(--color-success)" }}
          />
          {upLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-2 rounded-sm"
            style={{ background: "var(--color-danger)" }}
          />
          {downLabel}
        </span>
      </div>

      <div
        className="flex gap-2"
        style={{ height }}
        role="img"
        aria-label={points
          .map(
            (p) => `${p.label}: ${p.display ?? `${p.up} up, ${p.down} down`}`,
          )
          .join(", ")}
      >
        {points.map((p) => (
          // `h-full` on the month, not only `items-end` on the row: the bars
          // are sized as a percentage, and a percentage of an auto height is
          // zero — which renders a chart with a legend, an axis and no bars.
          <div key={p.label} className="flex h-full flex-1 items-end gap-0.5">
            {[
              { value: p.up, colour: "var(--color-success)" },
              { value: p.down, colour: "var(--color-danger)" },
            ].map((bar) => (
              <div
                key={bar.colour}
                className="flex-1 rounded-t"
                title={`${p.label}: ${p.display ?? ""}`}
                style={{
                  // Always at least a hairline: a bar of zero height reads as
                  // a missing month rather than an empty one.
                  height: `${Math.max(2, (Math.max(0, bar.value) / top) * 100)}%`,
                  background: bar.colour,
                }}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="mt-1 flex gap-2 text-[10px]" style={muted}>
        {points.map((p) => (
          <div key={p.label} className="flex-1 truncate text-center">
            {p.label}
          </div>
        ))}
      </div>
    </div>
  );
}

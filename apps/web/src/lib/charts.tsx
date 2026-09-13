import { type ReactNode, useId, useState } from "react";
import { muted } from "./ui";

/**
 * Charts, drawn by hand.
 *
 * A charting library is several hundred kilobytes and a dependency in a public
 * repo, for what a business dashboard actually needs: bars of one series, a
 * line of another, and two series against each other. All of it is a few dozen
 * lines of SVG, it scales with the box it is given, and nothing here has to be
 * kept in step with anyone's major version.
 *
 * They all take pre-formatted labels rather than formatting money themselves —
 * currency belongs to the caller, and a chart that assumes dollars is wrong on
 * the first instance that does not use them.
 *
 * **What was added, and why.** These drew a shape and left the reader to guess
 * at it: no scale, so a bar could be four thousand or forty; and a native
 * `title` for the value, which waits a second, cannot be styled, and does not
 * exist at all on a touch screen. A figure somebody cannot read is decoration.
 *
 * So: a scale down the side, a readout that follows the pointer and answers
 * immediately, a marker where the pointer is, and a legend that puts a series
 * away. Each of those is an interaction rather than a picture, which is the
 * half that was missing — and every one of them is drawn in the product's own
 * tokens rather than borrowed from a dashboard kit, so a chart still looks
 * like the screen around it.
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

/**
 * How a value on the scale is written.
 *
 * Passed in, because these charts do not know what they are counting. The
 * first cut formatted the raw number and every money chart in the product
 * labelled its axis in cents — a bar of fifteen thousand pounds was marked
 * "1.5M", beside a readout that correctly said £15,000. A scale that
 * contradicts the figure beside it is worse than no scale.
 *
 * The default is for counts, which is what a chart without money is.
 */
export type Format = (value: number) => string;

/** Short enough for an axis: 1.2k, 3.4M. The full figure is in the readout. */
export const brief: Format = (value) => {
  const n = Math.abs(value);
  if (n >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
};

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm" style={muted}>
      {children}
    </p>
  );
}

/**
 * The value under the pointer, said immediately.
 *
 * Positioned against the chart rather than the page, and flipped to the left
 * once it is past halfway so it never runs off the right edge of a card. It is
 * `aria-hidden` because the same figures are already in the chart's own
 * `aria-label` — a screen reader that read both would say everything twice.
 */
function Readout({
  at,
  children,
}: {
  at: number;
  children: ReactNode;
}) {
  const right = at > 55;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded border px-2 py-1 text-xs shadow-sm"
      style={{
        left: `${at}%`,
        top: 0,
        transform: right
          ? "translate(-100%, -0.25rem)"
          : "translate(0, -0.25rem)",
        background: "var(--surface-raised)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * The scale, behind the bars.
 *
 * Four lines and their values. Without them a bar is a shape: it says this
 * month beat last month and nothing about by how much, which is the question
 * somebody opened the chart with.
 */
function Grid({
  top,
  rows = 4,
  format = brief,
}: {
  top: number;
  rows?: number;
  format?: Format;
}) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex flex-col justify-between"
    >
      {Array.from({ length: rows + 1 }, (_, i) => (
        <div
          key={`${i}-${rows}`}
          className="flex items-center gap-1.5"
          style={{ height: 0 }}
        >
          <span
            className="w-8 shrink-0 text-right text-[10px] leading-none"
            style={muted}
          >
            {format((top / rows) * (rows - i))}
          </span>
          <span
            className="h-px flex-1"
            style={{
              background: "var(--border)",
              opacity: i === rows ? 1 : 0.5,
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function Bars({
  points,
  height = 140,
  format,
}: {
  points: Point[];
  height?: number;
  /** How the scale is written. Money charts pass their own. */
  format?: Format;
}) {
  const [at, setAt] = useState<number | null>(null);
  if (points.length === 0) return <Empty>Nothing to chart yet.</Empty>;

  const top = ceiling(points.map((p) => p.value));
  const shown = at === null ? null : points[at];

  return (
    <div>
      <div className="relative" style={{ height }}>
        <Grid top={top} format={format} />
        {shown ? (
          <Readout at={((at as number) + 0.5) * (100 / points.length)}>
            <span className="font-medium">{shown.label}</span>{" "}
            <span style={muted}>{shown.display ?? shown.value}</span>
          </Readout>
        ) : null}

        <div
          className="absolute inset-0 flex items-end gap-1 pl-10"
          role="img"
          aria-label={points
            .map((p) => `${p.label}: ${p.display ?? p.value}`)
            .join(", ")}
        >
          {points.map((p, i) => (
            <button
              key={p.label}
              type="button"
              // A button, so the readout is reachable by keyboard as well as by
              // pointer. A chart that only answers a mouse answers half a
              // business.
              className="flex h-full flex-1 cursor-default flex-col justify-end"
              onPointerEnter={() => setAt(i)}
              onPointerLeave={() => setAt(null)}
              onFocus={() => setAt(i)}
              onBlur={() => setAt(null)}
              aria-label={`${p.label}: ${p.display ?? p.value}`}
            >
              <div
                className="rounded-t transition-[height,opacity] duration-200"
                style={{
                  // Always at least a hairline: a bar of zero height reads as a
                  // missing month rather than an empty one.
                  height: `${Math.max(2, (Math.max(0, p.value) / top) * 100)}%`,
                  background: "var(--brand-on-white-text)",
                  opacity: at === null || at === i ? 1 : 0.45,
                }}
              />
            </button>
          ))}
        </div>
      </div>

      <div className="mt-1 flex gap-1 pl-10 text-[10px]" style={muted}>
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
  const [at, setAt] = useState<number | null>(null);
  const fillId = useId();

  if (points.length < 2) {
    return <Empty>Not enough history to draw a trend yet.</Empty>;
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
  const shown = at === null ? null : points[at];

  return (
    <div>
      <div className="relative" style={{ height }}>
        {shown ? (
          <Readout at={(x(at as number) / W) * 100}>
            <span className="font-medium">{shown.label}</span>{" "}
            <span style={muted}>{shown.display ?? shown.value}</span>
          </Readout>
        ) : null}

        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height: "100%" }}
          role="img"
          aria-label={points
            .map((p) => `${p.label}: ${p.display ?? p.value}`)
            .join(", ")}
        >
          <title>Trend over time</title>
          <defs>
            {/*
              A wash under the line, fading out. It reads as volume rather than
              decoration and is what separates a trend from a squiggle — kept
              faint so it never competes with the line itself.
            */}
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-brand-500)"
                stopOpacity="0.22"
              />
              <stop
                offset="100%"
                stopColor="var(--color-brand-500)"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>

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

          <polygon
            points={`0,${H} ${path} ${W},${H}`}
            fill={`url(#${fillId})`}
          />
          <polyline
            points={path}
            fill="none"
            stroke="var(--color-brand-500)"
            strokeWidth="0.8"
            vectorEffect="non-scaling-stroke"
          />

          {/* Where the pointer is, on the line rather than beside it. */}
          {at !== null ? (
            <>
              <line
                x1={x(at)}
                x2={x(at)}
                y1="0"
                y2={H}
                stroke="var(--border)"
                strokeWidth="0.5"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={x(at)}
                cy={y(points[at]?.value ?? 0)}
                r="1.4"
                fill="var(--surface-raised)"
                stroke="var(--color-brand-500)"
                strokeWidth="0.8"
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : null}
        </svg>

        {/*
          The pointer targets, over the chart.

          Separate from the drawing because an SVG stretched with
          `preserveAspectRatio="none"` distorts anything inside it — a circle
          drawn as a target would be an ellipse, and a hit area would be the
          wrong width at every size but one.
        */}
        <div className="absolute inset-0 flex">
          {points.map((p, i) => (
            <button
              key={p.label}
              type="button"
              className="h-full flex-1 cursor-default"
              onPointerEnter={() => setAt(i)}
              onPointerLeave={() => setAt(null)}
              onFocus={() => setAt(i)}
              onBlur={() => setAt(null)}
              aria-label={`${p.label}: ${p.display ?? p.value}`}
            />
          ))}
        </div>
      </div>

      <div className="mt-1 flex justify-between text-[10px]" style={muted}>
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/**
 * A trend at the size of a word, for a figure that already has a number.
 *
 * No axis, no readout, no interaction — a stat tile says what the number is and
 * this says which way it has been going. Anything more competes with the figure
 * it sits under.
 */
export function Sparkline({
  values,
  height = 28,
  tone = "var(--color-brand-500)",
}: {
  values: number[];
  height?: number;
  tone?: string;
}) {
  if (values.length < 2) return null;

  const W = 100;
  const H = 20;
  const min = Math.min(...values);
  const max = Math.max(...values, min + 1);
  const path = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * W},${H - ((v - min) / (max - min)) * H}`,
    )
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={path}
        fill="none"
        stroke={tone}
        strokeWidth="1.2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Two series against each other, month by month.
 *
 * Won and lost, side by side, sharing one scale so the bars are comparable —
 * two charts with independent axes would make a bad month look like a good one.
 *
 * The legend puts a series away. With one series hidden the other rescales to
 * its own ceiling, which is the point: a small number beside a large one is a
 * flat line until the large one is out of the way.
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
  format,
}: {
  points: PairedPoint[];
  height?: number;
  upLabel: string;
  downLabel: string;
  /** How the scale is written. Money charts pass their own. */
  format?: Format;
}) {
  const [at, setAt] = useState<number | null>(null);
  const [hidden, setHidden] = useState<"up" | "down" | null>(null);

  if (points.length === 0) return <Empty>Nothing to chart yet.</Empty>;

  const series = [
    { key: "up" as const, label: upLabel, colour: "var(--color-success)" },
    { key: "down" as const, label: downLabel, colour: "var(--color-danger)" },
  ];
  const showing = series.filter((s) => s.key !== hidden);

  // One scale across every series still shown, and across every month.
  const top = ceiling(points.flatMap((p) => showing.map((s) => p[s.key])));
  const shown = at === null ? null : points[at];

  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-xs">
        {series.map((s) => (
          <button
            key={s.key}
            type="button"
            className="flex items-center gap-1.5"
            aria-pressed={hidden !== s.key}
            style={hidden === s.key ? { opacity: 0.45 } : undefined}
            onClick={() => setHidden(hidden === s.key ? null : s.key)}
          >
            <span
              className="inline-block size-2 rounded-sm"
              style={{
                background: hidden === s.key ? "var(--text-muted)" : s.colour,
              }}
            />
            <span style={muted}>{s.label}</span>
          </button>
        ))}
      </div>

      <div className="relative" style={{ height }}>
        <Grid top={top} format={format} />
        {shown ? (
          <Readout at={((at as number) + 0.5) * (100 / points.length)}>
            <span className="font-medium">{shown.label}</span>{" "}
            <span style={muted}>
              {shown.display ?? `${shown.up} up, ${shown.down} down`}
            </span>
          </Readout>
        ) : null}

        <div
          className="absolute inset-0 flex gap-2 pl-10"
          role="img"
          aria-label={points
            .map(
              (p) => `${p.label}: ${p.display ?? `${p.up} up, ${p.down} down`}`,
            )
            .join(", ")}
        >
          {points.map((p, i) => (
            // `h-full` on the month, not only `items-end` on the row: the bars
            // are sized as a percentage, and a percentage of an auto height is
            // zero — which renders a chart with a legend, an axis and no bars.
            <button
              key={p.label}
              type="button"
              className="flex h-full flex-1 cursor-default items-end gap-0.5"
              onPointerEnter={() => setAt(i)}
              onPointerLeave={() => setAt(null)}
              onFocus={() => setAt(i)}
              onBlur={() => setAt(null)}
              aria-label={`${p.label}: ${
                p.display ?? `${p.up} up, ${p.down} down`
              }`}
            >
              {showing.map((s) => (
                <div
                  key={s.key}
                  className="flex-1 rounded-t transition-[height,opacity] duration-200"
                  style={{
                    // Always at least a hairline: a bar of zero height reads as
                    // a missing month rather than an empty one.
                    height: `${Math.max(2, (Math.max(0, p[s.key]) / top) * 100)}%`,
                    background: s.colour,
                    opacity: at === null || at === i ? 1 : 0.45,
                  }}
                />
              ))}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-1 flex gap-2 pl-10 text-[10px]" style={muted}>
        {points.map((p) => (
          <div key={p.label} className="flex-1 truncate text-center">
            {p.label}
          </div>
        ))}
      </div>
    </div>
  );
}

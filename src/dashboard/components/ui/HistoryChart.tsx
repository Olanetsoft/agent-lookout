import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { formatClock, formatClockMinutes } from "@dashboard/lib/format";
import { countAxis, timeTicks } from "@dashboard/lib/historyChart";
import { buildSteps, readAt, type SparkSample } from "@dashboard/lib/sparkline";
import { cn } from "@dashboard/lib/utils";

/** The line's colour. Needs you is drawn in the lamp's edge, which holds its contrast in both themes. */
const TONE = {
  "needs-you": "text-status-needs-you-edge",
  working: "text-status-working",
  idle: "text-status-idle",
} as const;

/** Room around the plot for the axis labels, in pixels. */
const MARGIN = { top: 12, right: 12, bottom: 24, left: 30 };
const HEIGHT = 220;
/** The least room a time label needs, so the axis never crowds. */
const TIME_LABEL_ROOM = 76;
/** A band this wide has room for its "Not measured" label. */
const BAND_LABEL_ROOM = 104;
/** How far one arrow key moves the reading, as a share of the window. */
const KEY_STEP = 1 / 60;

interface HistoryChartProps {
  samples: readonly SparkSample[];
  /** Left edge of the window, epoch milliseconds. */
  start: number;
  /** Right edge of the window: the present. */
  end: number;
  tone: keyof typeof TONE;
  /** What the chart shows, for assistive technology: "Sessions that need you". */
  label: string;
  /** A count in words, for the reading: `3 need you`. */
  describe: (value: number) => string;
  className?: string;
}

/**
 * A count over time, as a step line with a count axis and a time axis.
 * Hand-written SVG, measured to the width it is given.
 *
 * The window ends at the present. Time that was not measured is hatched and
 * labelled, never drawn as a line at zero. The hatch is an HTML layer under the
 * SVG, so it is the same `.unmeasured-hatch` the timeline and the Last hour
 * chart use. Pointing at the chart, or focusing it and pressing the arrow keys,
 * reads out the count at that moment, in a box of the floating glass.
 *
 * It is drawn for the dialog, on floating glass: the halo behind a label and
 * around the reading's dot is that glass's tint, not a solid colour.
 */
export function HistoryChart({
  samples,
  start,
  end,
  tone,
  label,
  describe,
  className,
}: HistoryChartProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Where the reading is taken, as a share of the window. Null when nothing points.
  const [point, setPoint] = useState<number | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const left = MARGIN.left;
  const right = Math.max(left + 1, width - MARGIN.right);
  const top = MARGIN.top;
  const bottom = HEIGHT - MARGIN.bottom;
  const span = end - start;

  let highest = 0;
  for (const sample of samples) {
    if (sample.at >= start && sample.at <= end && sample.value > highest) highest = sample.value;
  }
  const axis = countAxis(highest);
  const geometry = buildSteps(
    samples,
    { start, end },
    { left, right, top, bottom, ceiling: axis.ceiling },
  );
  const xOf = (at: number) => left + ((at - start) / span) * (right - left);
  const yOf = (value: number) => bottom - (value / axis.ceiling) * (bottom - top);
  const ticks = timeTicks(start, end, Math.max(1, Math.floor((right - left) / TIME_LABEL_ROOM)));

  // With nothing pointing, assistive technology hears the reading at the present.
  const share = point ?? 1;
  const at = start + share * span;
  const reading = readAt(geometry.runs, at);
  const said = reading ? describe(reading.value) : "Not measured";
  const x = xOf(at);

  const pointAt = (clientX: number, box: DOMRect) => {
    const plotLeft = box.left + left;
    const plotWidth = right - left;
    setPoint(Math.min(1, Math.max(0, (clientX - plotLeft) / plotWidth)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move: Record<string, (from: number) => number> = {
      ArrowLeft: (from) => from - KEY_STEP,
      ArrowRight: (from) => from + KEY_STEP,
      PageDown: (from) => from - KEY_STEP * 10,
      PageUp: (from) => from + KEY_STEP * 10,
      Home: () => 0,
      End: () => 1,
    };
    const step = move[event.key];
    if (!step) return;
    event.preventDefault();
    setPoint(Math.min(1, Math.max(0, step(point ?? 1))));
  };

  return (
    <div
      ref={frame}
      data-slot='history-chart'
      role='slider'
      tabIndex={0}
      aria-label={`${label}. Arrow keys read the count at each moment.`}
      aria-orientation='horizontal'
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      aria-valuetext={`${formatClock(at)}: ${said}`}
      onPointerMove={(event) => pointAt(event.clientX, event.currentTarget.getBoundingClientRect())}
      onPointerLeave={() => setPoint(null)}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) setPoint((current) => current ?? 1);
      }}
      onBlur={() => setPoint(null)}
      onKeyDown={onKeyDown}
      className={cn("relative w-full cursor-crosshair rounded-row", TONE[tone], className)}
      style={{ height: HEIGHT }}
    >
      {width > 0 &&
        geometry.unmeasured.map((band, index) => (
          <div
            key={index}
            aria-hidden
            data-part='unmeasured'
            className='unmeasured-hatch absolute'
            style={{ left: band.x, top, width: band.width, height: bottom - top }}
          />
        ))}

      {width > 0 && (
        <svg aria-hidden width={width} height={HEIGHT} className='relative block'>
          {axis.ticks.map((value) => (
            <g key={value}>
              <line
                data-part='grid'
                x1={left}
                x2={right}
                y1={yOf(value)}
                y2={yOf(value)}
                stroke={value === 0 ? "var(--rule-strong)" : "var(--hairline)"}
                strokeWidth={1}
                shapeRendering='crispEdges'
              />
              <text
                x={left - 8}
                y={yOf(value)}
                dy='0.32em'
                textAnchor='end'
                className='fill-ink-muted font-mono text-micro'
              >
                {value}
              </text>
            </g>
          ))}

          {geometry.unmeasured.map(
            (band, index) =>
              band.width >= BAND_LABEL_ROOM && (
                <text
                  key={index}
                  data-part='unmeasured-label'
                  x={band.x + 8}
                  y={top + 14}
                  className='fill-ink-muted font-mono text-micro'
                  // A halo of the floating glass the chart sits on, so the hatch
                  // does not run through the letters. It is the tint the dialog
                  // is made of, so it shows as nothing but a gap in the hatch.
                  stroke='var(--glass-float)'
                  strokeWidth={4}
                  strokeLinejoin='round'
                  paintOrder='stroke'
                >
                  Not measured
                </text>
              ),
          )}

          {geometry.areas.map((d, index) => (
            <path key={index} d={d} fill='currentColor' stroke='none' opacity={0.1} />
          ))}
          {geometry.lines.map((d, index) => (
            <path
              key={index}
              data-part='line'
              d={d}
              fill='none'
              stroke='currentColor'
              strokeWidth={2}
              strokeLinecap='round'
              strokeLinejoin='round'
            />
          ))}

          {ticks.map((tick) => {
            const tickX = xOf(tick);
            if (tickX < left + 16 || tickX > right - 16) return null;
            return (
              <text
                key={tick}
                data-part='time-tick'
                x={tickX}
                y={HEIGHT - 6}
                textAnchor='middle'
                className='fill-ink-muted font-mono text-micro'
              >
                {formatClockMinutes(tick)}
              </text>
            );
          })}

          {point !== null && (
            <g data-part='crosshair'>
              <line
                x1={x}
                x2={x}
                y1={top}
                y2={bottom}
                stroke='var(--ink-muted)'
                strokeWidth={1}
                shapeRendering='crispEdges'
              />
              {reading && (
                <circle
                  cx={x}
                  cy={yOf(Math.min(reading.value, axis.ceiling))}
                  r={4.5}
                  fill='currentColor'
                  stroke='var(--glass-float)'
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
      )}

      {point !== null && width > 0 && (
        <div
          aria-hidden
          data-part='reading'
          className='pointer-events-none absolute z-10 rounded-row bg-glass-float px-2.5 py-1.5 font-mono text-fact whitespace-nowrap inset-ring inset-ring-rule'
          // It sits beside the rule, and changes side before it would leave the chart.
          style={share > 0.62 ? { top, right: width - x + 10 } : { top, left: x + 10 }}
        >
          <span className='block text-ink-muted'>{formatClock(at)}</span>
          <span className='block text-ink'>{said}</span>
        </div>
      )}
    </div>
  );
}

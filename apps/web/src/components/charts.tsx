// Hand-written SVG charts for real API data. No chart library: these are a few paths each, and
// owning them keeps the look consistent and the bundle small.
import { useId, useState } from 'react';
import type { Stats } from '../types.ts';

const COLOR = {
  ember: '#ff8d58',
  mint: '#4fe3a1',
  rose: '#ff5f7e',
  ice: '#82a9ff',
  amber: '#f6b94a',
};
export type ChartColor = keyof typeof COLOR;

/** A tiny area chart. Flat (not missing) when every value is zero. */
export function Sparkline({
  values,
  color = 'ember',
  className = 'h-10 w-full',
}: {
  values: number[];
  color?: ChartColor;
  className?: string;
}) {
  const id = useId();
  if (values.length < 2) return null;
  const W = 120;
  const H = 32;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 2 - (v / max) * (H - 6)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x!.toFixed(1)},${y!.toFixed(1)}`).join('');
  const c = COLOR[color];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c} stopOpacity="0.28" />
          <stop offset="1" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={c} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A circular gauge for a 0..1 ratio (null = no data yet). */
export function Ring({ value, size = 56 }: { value: number | null; size?: number }) {
  const r = 22;
  const C = 2 * Math.PI * r;
  const v = value ?? 0;
  const color =
    value === null ? '#3b4558' : v >= 0.98 ? COLOR.mint : v >= 0.9 ? COLOR.amber : COLOR.rose;
  return (
    <svg viewBox="0 0 56 56" width={size} height={size} aria-hidden="true" className="-rotate-90">
      <circle cx="28" cy="28" r={r} fill="none" stroke="#1d2431" strokeWidth="5" />
      <circle
        cx="28"
        cy="28"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${C * v} ${C}`}
        style={{
          filter: `drop-shadow(0 0 4px ${color}88)`,
          transition: 'stroke-dasharray .6s ease',
        }}
      />
    </svg>
  );
}

const niceMax = (n: number) => {
  if (n <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(n));
  const m = n / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};

const hourLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * 24 hours of traffic: stacked bars of delivery attempts (delivered / failed) with the events
 * received drawn as a line over them. Hover (or focus) a column for exact numbers.
 */
export function TrafficChart({ series }: { series: Stats['series'] }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 220;
  const PAD = { l: 34, r: 8, t: 12, b: 26 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const max = niceMax(
    Math.max(1, ...series.map((p) => Math.max(p.events, p.delivered + p.failed))),
  );
  const col = iw / Math.max(1, series.length);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const line = series
    .map(
      (p, i) => `${i ? 'L' : 'M'}${(PAD.l + col * (i + 0.5)).toFixed(1)},${y(p.events).toFixed(1)}`,
    )
    .join('');
  const h = hover === null ? null : series[hover];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Events received and delivery attempts per hour over the last 24 hours"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`${id}-ok`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={COLOR.mint} stopOpacity="0.85" />
            <stop offset="1" stopColor={COLOR.mint} stopOpacity="0.35" />
          </linearGradient>
          <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={COLOR.ember} stopOpacity="0.18" />
            <stop offset="1" stopColor={COLOR.ember} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(max * f)}
              y2={y(max * f)}
              stroke="#1d2431"
              strokeDasharray={f ? '2 4' : undefined}
            />
            <text
              x={PAD.l - 8}
              y={y(max * f) + 3}
              textAnchor="end"
              className="fill-[#5c6579] font-mono text-[9px]"
            >
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {series.map((p, i) => {
          const x = PAD.l + col * i + col * 0.22;
          const bw = col * 0.56;
          const okH = (p.delivered / max) * ih;
          const badH = (p.failed / max) * ih;
          return (
            <g key={p.hour}>
              {hover === i && (
                <rect
                  x={PAD.l + col * i}
                  y={PAD.t}
                  width={col}
                  height={ih}
                  fill="#ffffff"
                  opacity="0.03"
                />
              )}
              <rect
                x={x}
                y={PAD.t + ih - okH}
                width={bw}
                height={okH}
                rx="1.5"
                fill={`url(#${id}-ok)`}
              />
              <rect
                x={x}
                y={PAD.t + ih - okH - badH}
                width={bw}
                height={badH}
                rx="1.5"
                fill={COLOR.rose}
                opacity="0.85"
              />
              {i % 6 === 0 && (
                <text
                  x={PAD.l + col * (i + 0.5)}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-[#5c6579] font-mono text-[9px]"
                >
                  {hourLabel(p.hour)}
                </text>
              )}
              <rect
                x={PAD.l + col * i}
                y={PAD.t}
                width={col}
                height={ih}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
        <path
          d={`${line}L${PAD.l + col * (series.length - 0.5)},${PAD.t + ih}L${PAD.l + col * 0.5},${PAD.t + ih}Z`}
          fill={`url(#${id}-area)`}
          pointerEvents="none"
        />
        <path
          d={line}
          fill="none"
          stroke={COLOR.ember}
          strokeWidth="1.75"
          strokeLinejoin="round"
          pointerEvents="none"
        />
        {series.map((p, i) =>
          p.events > 0 || hover === i ? (
            <circle
              key={p.hour}
              cx={PAD.l + col * (i + 0.5)}
              cy={y(p.events)}
              r={hover === i ? 3.5 : 2}
              fill="#05070b"
              stroke={COLOR.ember}
              strokeWidth="1.5"
              pointerEvents="none"
            />
          ) : null,
        )}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border border-ink-600 bg-ink-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
          style={{
            left: `${((PAD.l + col * (hover + 0.5)) / W) * 100}%`,
            transform: `translateX(${hover > series.length / 2 ? '-105%' : '5%'})`,
          }}
        >
          <p className="mb-1.5 font-mono text-[10px] text-dim">
            {hourLabel(h.hour)} –{' '}
            {hourLabel(new Date(new Date(h.hour).getTime() + 3_600_000).toISOString())}
          </p>
          <Row color="bg-ember-400" label="Events received" value={h.events} />
          <Row color="bg-mint-400" label="Delivered" value={h.delivered} />
          <Row color="bg-rose-400" label="Failed attempts" value={h.failed} />
        </div>
      )}
    </div>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <p className="flex items-center gap-2 py-0.5">
      <span className={`size-2 rounded-sm ${color}`} />
      <span className="text-muted">{label}</span>
      <span className="ml-auto pl-4 font-mono text-fg">{value}</span>
    </p>
  );
}

/** One horizontal bar split into proportional segments, with a legend under it. */
export function SegmentBar({
  segments,
}: {
  segments: { label: string; value: number; className: string }[];
}) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  return (
    <div className="space-y-3">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-ink-700">
        {total > 0 &&
          segments.map((s) =>
            s.value > 0 ? (
              <div
                key={s.label}
                className={`${s.className} transition-[width] duration-700`}
                style={{ width: `${(s.value / total) * 100}%` }}
                title={`${s.label}: ${s.value}`}
              />
            ) : null,
          )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-xs">
            <span className={`size-2 rounded-sm ${s.className}`} />
            <dt className="text-muted">{s.label}</dt>
            <dd className="ml-auto font-mono text-fg">{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

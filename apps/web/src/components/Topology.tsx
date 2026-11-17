// The relay graph: the user's endpoints on the left, the relay core in the middle, their
// destinations on the right. A packet runs along the edges only when a real new event arrives
// (detected by the polled activity feed), so an idle account shows a still graph.
import { useEffect, useRef, useState } from 'react';

import type { Destination, Endpoint } from '../types.ts';

export type Arrival = { key: string; endpointId: string };

const W = 720;
const ROW = 54;
const X_IN = 150;
const X_CORE = 360;
const X_OUT = 570;
const LEG1 = 650;
const LEG2 = 750;

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
};
/** A point on the same cubic Bézier as `curve` (control points at the horizontal midpoint). */
const along = (x1: number, y1: number, x2: number, y2: number, t: number) => {
  const mx = (x1 + x2) / 2;
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * x1 + (b + c) * mx + d * x2, y: (a + b) * y1 + (c + d) * y2 };
};

export function Topology({
  endpoints,
  destinations,
  arrivals,
}: {
  endpoints: Pick<Endpoint, 'id' | 'name' | 'paused'>[];
  destinations: Record<string, Destination[] | undefined>;
  arrivals: Arrival[];
}) {
  const outs = endpoints.flatMap((e) =>
    (destinations[e.id] ?? []).map((d) => ({ ...d, from: e.id })),
  );
  const rows = Math.max(endpoints.length, outs.length, 1);
  const H = rows * ROW + 24;
  const yOf = (i: number, n: number) => 12 + (H - 24) / 2 + (i - (n - 1) / 2) * ROW;
  const coreY = H / 2;

  const inY = new Map(endpoints.map((e, i) => [e.id, yOf(i, endpoints.length)]));
  const outY = new Map(outs.map((d, i) => [d.id, yOf(i, outs.length)]));

  // Packets in flight, animated with requestAnimationFrame while any exist.
  const [packets, setPackets] = useState<{ key: string; endpointId: string; start: number }[]>([]);
  const [now, setNow] = useState(0);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const fresh = arrivals.filter((a) => !seen.current.has(a.key));
    if (fresh.length === 0) return;
    for (const a of fresh) seen.current.add(a.key);
    const t = performance.now();
    // Stagger bursts so several events in one poll read as separate packets.
    setPackets((p) => [...p, ...fresh.slice(0, 12).map((a, i) => ({ ...a, start: t + i * 220 }))]);
  }, [arrivals]);

  useEffect(() => {
    if (packets.length === 0) return;
    let raf = 0;
    const tick = (t: number) => {
      setNow(t);
      setPackets((p) => {
        const live = p.filter((k) => t - k.start < LEG1 + LEG2 + 80);
        return live.length === p.length ? p : live;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [packets.length]);

  const ease = (f: number) => 1 - (1 - f) ** 3;
  const coreHot = packets.some((p) => {
    const t = now - p.start;
    return t > LEG1 - 60 && t < LEG1 + 300;
  });
  const hotOut = new Set<string>();
  const hotIn = new Set<string>();

  const dots: { key: string; x: number; y: number }[] = [];
  for (const p of packets) {
    const t = now - p.start;
    if (t < 0) continue;
    if (t < LEG1) {
      hotIn.add(p.endpointId);
      const y = inY.get(p.endpointId);
      if (y === undefined) continue;
      const pt = along(X_IN + 8, y, X_CORE - 34, coreY, ease(Math.min(1, t / LEG1)));
      dots.push({ key: `${p.key}-in`, ...pt });
    } else {
      for (const d of outs) {
        if (d.from !== p.endpointId || !d.enabled) continue;
        hotOut.add(d.id);
        const pt = along(
          X_CORE + 34,
          coreY,
          X_OUT - 8,
          outY.get(d.id)!,
          ease(Math.min(1, (t - LEG1) / LEG2)),
        );
        dots.push({ key: `${p.key}-${d.id}`, ...pt });
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Relay topology: endpoints, relay core and destinations"
    >
      <defs>
        <radialGradient id="topo-core">
          <stop offset="0" stopColor="#ff6a2b" stopOpacity="0.5" />
          <stop offset="1" stopColor="#ff6a2b" stopOpacity="0" />
        </radialGradient>
        <filter id="topo-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
      </defs>

      {endpoints.map((e) => (
        <path
          key={e.id}
          d={curve(X_IN + 8, inY.get(e.id)!, X_CORE - 34, coreY)}
          fill="none"
          stroke={hotIn.has(e.id) ? '#82a9ff' : '#2a3243'}
          strokeOpacity={hotIn.has(e.id) ? 0.8 : 1}
          strokeWidth="1.25"
          className="transition-[stroke] duration-300"
        />
      ))}
      {outs.map((d) => (
        <path
          key={d.id}
          d={curve(X_CORE + 34, coreY, X_OUT - 8, outY.get(d.id)!)}
          fill="none"
          stroke={hotOut.has(d.id) ? '#ff8d58' : d.enabled ? '#2a3243' : '#1d2431'}
          strokeDasharray={d.enabled ? undefined : '3 4'}
          strokeWidth="1.25"
          className="transition-[stroke] duration-300"
        />
      ))}

      {/* Core */}
      <circle
        cx={X_CORE}
        cy={coreY}
        r={coreHot ? 60 : 44}
        fill="url(#topo-core)"
        className="transition-all duration-300"
        opacity={coreHot ? 1 : 0.55}
      />
      <rect
        x={X_CORE - 34}
        y={coreY - 22}
        width="68"
        height="44"
        rx="12"
        fill="#0c1017"
        stroke={coreHot ? '#ff8d58' : '#3b4558'}
        className="transition-[stroke] duration-300"
      />
      <text
        x={X_CORE}
        y={coreY - 2}
        textAnchor="middle"
        className="fill-[#e9edf5] text-[10px] font-semibold"
      >
        RELAY
      </text>
      <text
        x={X_CORE}
        y={coreY + 11}
        textAnchor="middle"
        className="fill-[#5c6579] font-mono text-[8.5px]"
      >
        queue · retry
      </text>

      {/* Endpoints */}
      {endpoints.map((e) => {
        const y = inY.get(e.id)!;
        return (
          <g key={e.id}>
            <text
              x={X_IN - 8}
              y={y - 2}
              textAnchor="end"
              className="fill-[#e9edf5] text-[11px] font-medium"
            >
              {clip(e.name, 22)}
            </text>
            <text
              x={X_IN - 8}
              y={y + 11}
              textAnchor="end"
              className="fill-[#5c6579] font-mono text-[9px]"
            >
              {e.paused ? 'paused · holding' : 'endpoint'}
            </text>
            <circle
              cx={X_IN}
              cy={y}
              r="4.5"
              fill="#05070b"
              stroke={e.paused ? '#f6b94a' : '#82a9ff'}
              strokeWidth="1.5"
            />
          </g>
        );
      })}

      {/* Destinations */}
      {outs.map((d) => {
        const y = outY.get(d.id)!;
        return (
          <g key={d.id} opacity={d.enabled ? 1 : 0.5}>
            <circle
              cx={X_OUT}
              cy={y}
              r="4.5"
              fill="#05070b"
              stroke={hotOut.has(d.id) ? '#ff8d58' : d.enabled ? '#4fe3a1' : '#3b4558'}
              strokeWidth="1.5"
            />
            <text x={X_OUT + 12} y={y - 2} className="fill-[#e9edf5] font-mono text-[10.5px]">
              {clip(host(d.url), 26)}
            </text>
            <text x={X_OUT + 12} y={y + 11} className="fill-[#5c6579] font-mono text-[9px]">
              {d.enabled ? `${d.maxAttempts} attempts · ${d.timeoutMs / 1000}s` : 'disabled'}
            </text>
          </g>
        );
      })}
      {outs.length === 0 && (
        <text x={X_OUT} y={coreY + 4} className="fill-[#5c6579] text-[11px]">
          No destinations yet
        </text>
      )}

      {/* Packets */}
      {dots.map((d) => (
        <g key={d.key}>
          <circle cx={d.x} cy={d.y} r="6" fill="#ff8d58" filter="url(#topo-glow)" opacity="0.9" />
          <circle cx={d.x} cy={d.y} r="2.2" fill="#fff" />
        </g>
      ))}
    </svg>
  );
}

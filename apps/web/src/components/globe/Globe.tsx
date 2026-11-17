// The landing-page globe: a dot-matrix Earth drawn on one <canvas> with a hand-written
// orthographic projection (no WebGL, no map library). The relay hub sits in Singapore, where the
// service really runs; webhooks fly in from provider cities (ice blue) and deliveries fan out
// again (ember). It is an illustration of the flow, so it shows no numbers.
//
// Cost control: the animation stops when the canvas is off-screen or the tab is hidden, and a
// single still frame is drawn for prefers-reduced-motion.
import { useEffect, useRef } from 'react';
import { LAND } from './land.ts';

type Vec = [number, number, number];
type City = { name: string; lat: number; lon: number };

export const HUB: City = { name: 'SIN', lat: 1.35, lon: 103.82 };
const CITIES: City[] = [
  { name: 'SFO', lat: 37.77, lon: -122.42 },
  { name: 'NYC', lat: 40.71, lon: -74.0 },
  { name: 'YYZ', lat: 43.65, lon: -79.38 },
  { name: 'MEX', lat: 19.43, lon: -99.13 },
  { name: 'GRU', lat: -23.55, lon: -46.63 },
  { name: 'LHR', lat: 51.5, lon: -0.12 },
  { name: 'FRA', lat: 50.11, lon: 8.68 },
  { name: 'ARN', lat: 59.33, lon: 18.07 },
  { name: 'LOS', lat: 6.52, lon: 3.38 },
  { name: 'JNB', lat: -26.2, lon: 28.05 },
  { name: 'DXB', lat: 25.2, lon: 55.27 },
  { name: 'BOM', lat: 19.08, lon: 72.88 },
  { name: 'BLR', lat: 12.97, lon: 77.59 },
  { name: 'CGK', lat: -6.2, lon: 106.85 },
  { name: 'HKG', lat: 22.32, lon: 114.17 },
  { name: 'ICN', lat: 37.57, lon: 126.98 },
  { name: 'NRT', lat: 35.68, lon: 139.69 },
  { name: 'SYD', lat: -33.87, lon: 151.21 },
];

const RAD = Math.PI / 180;
const toVec = (lat: number, lon: number): Vec => [
  Math.cos(lat * RAD) * Math.sin(lon * RAD),
  Math.sin(lat * RAD),
  Math.cos(lat * RAD) * Math.cos(lon * RAD),
];

/** Land cells as unit vectors, thinned towards the poles so the dot spacing stays even. */
function landPoints(): Float32Array {
  const raw = atob(LAND.bits);
  const out: number[] = [];
  for (let r = 0; r < LAND.rows; r++) {
    const lat = LAND.lat0 - r * LAND.step;
    const stride = Math.max(1, Math.round(1 / Math.cos(lat * RAD)));
    for (let c = 0; c < LAND.cols; c += stride) {
      const k = r * LAND.cols + c;
      if (raw.charCodeAt(k >> 3) & (1 << (k & 7))) {
        out.push(...toVec(lat, -180 + c * LAND.step + LAND.step / 2));
      }
    }
  }
  return new Float32Array(out);
}

type Packet = { a: Vec; b: Vec; omega: number; start: number; dur: number; kind: 'in' | 'out' };
type Ripple = { p: Vec; start: number; kind: 'in' | 'out' };

const COLORS = {
  in: [130, 169, 255] as const, // ice-400
  out: [255, 141, 88] as const, // ember-400
};

function slerp(a: Vec, b: Vec, omega: number, t: number, lift: number): Vec {
  const s = Math.sin(omega) || 1;
  const k1 = Math.sin((1 - t) * omega) / s;
  const k2 = Math.sin(t * omega) / s;
  const h = 1 + lift * Math.sin(Math.PI * t);
  return [(a[0] * k1 + b[0] * k2) * h, (a[1] * k1 + b[1] * k2) * h, (a[2] * k1 + b[2] * k2) * h];
}

export function Globe({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const land = landPoints();
    const hub = toVec(HUB.lat, HUB.lon);
    const cities = CITIES.map((c) => ({ ...c, v: toVec(c.lat, c.lon) }));

    // View state: yaw/pitch in radians. Start looking at the hub, slightly from the north.
    let yaw = -HUB.lon * RAD + 0.55;
    let pitch = 0.32;
    let velocity = 0;
    const AUTO = -0.045; // rad/s, eastward drift
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (reduced) draw(performance.now());
    };

    const packets: Packet[] = [];
    const ripples: Ripple[] = [];
    const launch = (a: Vec, b: Vec, kind: Packet['kind'], now: number) => {
      const omega = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      packets.push({ a, b, omega, start: now, dur: 1400 + omega * 900, kind });
    };
    const pick = () => cities[Math.floor(Math.random() * cities.length)]!.v;

    let nextSpawn = 0;
    const step = (now: number) => {
      if (now >= nextSpawn) {
        launch(pick(), hub, 'in', now);
        nextSpawn = now + 380 + Math.random() * 520;
      }
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i]!;
        if (now - p.start < p.dur) continue;
        packets.splice(i, 1);
        ripples.push({ p: p.b, start: now, kind: p.kind });
        if (p.kind === 'in') {
          // The relay fans each webhook out to one or two destinations.
          const fan = Math.random() < 0.35 ? 2 : 1;
          for (let f = 0; f < fan; f++) launch(hub, pick(), 'out', now + 120 * f);
        }
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        if (now - ripples[i]!.start > 1200) ripples.splice(i, 1);
      }
    };

    // Projection for the current frame.
    let cy0 = 1;
    let sy0 = 0;
    let cp = 1;
    let sp = 0;
    let R = 1;
    let cx = 0;
    let cyc = 0;
    const project = (v: Vec): [number, number, number] => {
      const x1 = v[0] * cy0 + v[2] * sy0;
      const z1 = -v[0] * sy0 + v[2] * cy0;
      const y2 = v[1] * cp - z1 * sp;
      const z2 = v[1] * sp + z1 * cp;
      return [cx + x1 * R, cyc - y2 * R, z2];
    };
    /** Behind the globe's disc (lifted arc points can still show past the limb). */
    const hidden = (sx: number, sy: number, z: number) =>
      z < 0 && Math.hypot(sx - cx, sy - cyc) < R;

    const draw = (now: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      R = Math.min(w, h) * 0.42;
      cx = w / 2;
      cyc = h / 2;
      cy0 = Math.cos(yaw);
      sy0 = Math.sin(yaw);
      cp = Math.cos(pitch);
      sp = Math.sin(pitch);

      // Atmosphere and body.
      const halo = ctx.createRadialGradient(cx, cyc, R * 0.9, cx, cyc, R * 1.35);
      halo.addColorStop(0, 'rgba(91,134,240,0.20)');
      halo.addColorStop(0.35, 'rgba(91,134,240,0.06)');
      halo.addColorStop(1, 'rgba(91,134,240,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);
      const body = ctx.createRadialGradient(cx - R * 0.35, cyc - R * 0.4, R * 0.1, cx, cyc, R);
      body.addColorStop(0, '#111a2b');
      body.addColorStop(0.7, '#090d16');
      body.addColorStop(1, '#06080d');
      ctx.beginPath();
      ctx.arc(cx, cyc, R, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.strokeStyle = 'rgba(130,169,255,0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Land: brighter towards the centre, fading at the limb.
      const size = Math.max(1.1, R / 260);
      for (let i = 0; i < land.length; i += 3) {
        const x1 = land[i]! * cy0 + land[i + 2]! * sy0;
        const z1 = -land[i]! * sy0 + land[i + 2]! * cy0;
        const z2 = land[i + 1]! * sp + z1 * cp;
        if (z2 <= 0.02) continue;
        const y2 = land[i + 1]! * cp - z1 * sp;
        ctx.fillStyle = `rgba(168,186,222,${(0.1 + z2 * 0.5).toFixed(3)})`;
        ctx.fillRect(cx + x1 * R - size / 2, cyc - y2 * R - size / 2, size, size);
      }

      // Arcs and packets.
      for (const p of packets) {
        const t = (now - p.start) / p.dur;
        if (t < 0) continue;
        const lift = 0.06 + 0.14 * (p.omega / Math.PI);
        const [r, g, b] = COLORS[p.kind];
        // The faint full route.
        ctx.beginPath();
        let pen = false;
        for (let s = 0; s <= 40; s++) {
          const [sx, sy, z] = project(slerp(p.a, p.b, p.omega, s / 40, lift));
          if (hidden(sx, sy, z)) {
            pen = false;
            continue;
          }
          if (pen) ctx.lineTo(sx, sy);
          else ctx.moveTo(sx, sy);
          pen = true;
        }
        ctx.strokeStyle = `rgba(${r},${g},${b},0.13)`;
        ctx.lineWidth = 1;
        ctx.stroke();
        // The comet: a short trail behind the head, brightening towards it.
        const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const tail = 0.16;
        let prev: [number, number, number] | null = null;
        for (let s = 0; s <= 12; s++) {
          const tt = Math.max(0, ease - tail + (tail * s) / 12);
          const cur = project(slerp(p.a, p.b, p.omega, tt, lift));
          if (prev && !hidden(cur[0], cur[1], cur[2]) && !hidden(prev[0], prev[1], prev[2])) {
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(cur[0], cur[1]);
            ctx.strokeStyle = `rgba(${r},${g},${b},${((s / 12) * 0.9).toFixed(3)})`;
            ctx.lineWidth = 0.6 + (s / 12) * 1.6;
            ctx.stroke();
          }
          prev = cur;
        }
        if (prev && !hidden(prev[0], prev[1], prev[2])) {
          const glow = ctx.createRadialGradient(prev[0], prev[1], 0, prev[0], prev[1], 9);
          glow.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
          glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
          ctx.fillStyle = glow;
          ctx.fillRect(prev[0] - 9, prev[1] - 9, 18, 18);
          ctx.fillStyle = '#fff';
          ctx.fillRect(prev[0] - 1, prev[1] - 1, 2, 2);
        }
      }

      // Landing ripples.
      for (const rp of ripples) {
        const [sx, sy, z] = project(rp.p);
        if (z <= 0) continue;
        const k = (now - rp.start) / 1200;
        const [r, g, b] = COLORS[rp.kind];
        ctx.beginPath();
        ctx.ellipse(sx, sy, 3 + k * 16, (3 + k * 16) * Math.max(0.25, z), 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${r},${g},${b},${(0.7 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Cities.
      ctx.font = '500 9px "Geist Mono Variable", ui-monospace, monospace';
      for (const c of cities) {
        const [sx, sy, z] = project(c.v);
        if (z <= 0.05) continue;
        ctx.fillStyle = `rgba(200,214,240,${(0.35 + z * 0.5).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 1.6, 0, Math.PI * 2);
        ctx.fill();
        if (z > 0.35) {
          ctx.fillStyle = `rgba(140,149,168,${((z - 0.35) * 1.1).toFixed(3)})`;
          ctx.fillText(c.name, sx + 5, sy + 3);
        }
      }

      // The hub, pulsing.
      const [hx, hy, hz] = project(hub);
      if (hz > 0) {
        const pulse = reduced ? 0.5 : (now % 2400) / 2400;
        const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 28);
        g.addColorStop(0, 'rgba(255,106,43,0.55)');
        g.addColorStop(1, 'rgba(255,106,43,0)');
        ctx.fillStyle = g;
        ctx.fillRect(hx - 28, hy - 28, 56, 56);
        ctx.beginPath();
        ctx.arc(hx, hy, 4 + pulse * 18, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,141,88,${(0.8 * (1 - pulse)).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd2b8';
        ctx.fill();
        ctx.font = '600 10px "Geist Mono Variable", ui-monospace, monospace';
        ctx.fillStyle = 'rgba(255,177,138,0.95)';
        ctx.fillText('RELAY · SIN', hx + 9, hy - 7);
      }
    };

    // Animation loop, only while visible.
    let raf = 0;
    let running = false;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!dragging) {
        velocity += (AUTO - velocity) * Math.min(1, dt * 1.5);
        yaw += velocity * dt;
      }
      step(now);
      draw(now);
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (running || reduced) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    let onScreen = true;
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      if (onScreen && !document.hidden) start();
      else stop();
    });
    io.observe(canvas);
    const onVisibility = () => (document.hidden || !onScreen ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    if (reduced) {
      // One still frame with a few routes frozen mid-flight.
      const now = performance.now();
      for (let i = 0; i < 7; i++) {
        launch(cities[(i * 5) % cities.length]!.v, hub, 'in', now - 700);
        launch(hub, cities[(i * 7 + 3) % cities.length]!.v, 'out', now - 500);
      }
      draw(now);
    }

    // Drag to spin, with inertia.
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const k = 1 / (R || 200);
      const dx = (e.clientX - lastX) * k;
      yaw += dx;
      pitch = Math.max(-0.7, Math.min(1.0, pitch + (e.clientY - lastY) * k));
      velocity = dx * 60;
      lastX = e.clientX;
      lastY = e.clientY;
      if (reduced) draw(performance.now());
    };
    const onUp = () => {
      dragging = false;
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`block h-full w-full cursor-grab touch-pan-y active:cursor-grabbing ${className}`}
      role="img"
      aria-label="Globe illustrating webhooks flowing into the relay in Singapore and out to destinations around the world"
    />
  );
}

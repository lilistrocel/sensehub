import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Chart - responsive SVG line chart with ONE Y-AXIS PER UNIT.
 *
 * Series are grouped by `unit`; every unit gets its own panel (small multiple)
 * stacked under a shared time axis, so two measures never share a scale and a
 * series is never drawn against a wrong axis. Flat series are not barcodes: the
 * visible span is at least max(|mid| * 8 %, 0.5).
 *
 * Colour is a *tone* from the house palette (lighting / caution / water / ok /
 * idle), never a random hue. Text never wears the series colour: ticks, legend
 * and the readout are ink/muted; identity comes from the line key beside them.
 *
 * props:
 *   series      [{ key, label, unit, tone, points: [{ t: epochMs, v: number }] }]
 *   domain      [minMs, maxMs] optional x-range (defaults to data extent)
 *   formatTime  (ms, { long }) => string   axis tick (short) and readout (long)
 *   panelHeight px per unit panel (default 150)
 *   precision   decimals in the readout (default 1)
 *   emptyText   shown when no series has points
 */

const TONE = {
  lighting: { stroke: 'stroke-lighting-500 dark:stroke-lighting-400', fill: 'fill-lighting-500 dark:fill-lighting-400', bg: 'bg-lighting-500 dark:bg-lighting-400' },
  caution: { stroke: 'stroke-caution-500 dark:stroke-caution-400', fill: 'fill-caution-500 dark:fill-caution-400', bg: 'bg-caution-500 dark:bg-caution-400' },
  water: { stroke: 'stroke-water-500 dark:stroke-water-400', fill: 'fill-water-500 dark:fill-water-400', bg: 'bg-water-500 dark:bg-water-400' },
  ok: { stroke: 'stroke-ok-500 dark:stroke-ok-400', fill: 'fill-ok-500 dark:fill-ok-400', bg: 'bg-ok-500 dark:bg-ok-400' },
  idle: { stroke: 'stroke-state-idle', fill: 'fill-state-idle', bg: 'bg-state-idle' },
};
const toneOf = (t) => TONE[t] || TONE.idle;

const MARGIN = { left: 56, right: 14, top: 22, gap: 18, xAxis: 26 };

/** Clean tick step (1/2/5 x 10^n) for roughly `count` divisions. */
function niceStep(span, count) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return f * mag;
}

function yTicks(min, max, count = 4) {
  const step = niceStep(max - min, count);
  const first = Math.ceil(min / step) * step;
  const out = [];
  for (let v = first; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(10)));
  return { ticks: out, step };
}

function formatTick(v, step) {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Y domain for a panel: data extent, min visible span, 8 % headroom. */
function yDomain(values) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const mid = (min + max) / 2;
  const minSpan = Math.max(Math.abs(mid) * 0.08, 0.5);
  if (max - min < minSpan) {
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
  }
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
}

/** Median gap between consecutive points, for line breaks and hover tolerance. */
function medianGap(points) {
  if (points.length < 2) return Infinity;
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i].t - points[i - 1].t);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || Infinity;
}

/** Nearest point in a t-sorted array (binary search). */
function nearest(points, t) {
  if (points.length === 0) return null;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const a = points[lo];
  const b = points[lo - 1];
  if (b && Math.abs(b.t - t) < Math.abs(a.t - t)) return b;
  return a;
}

function useMeasuredWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export default function Chart({
  series = [],
  domain,
  formatTime,
  panelHeight = 150,
  precision = 1,
  emptyText = 'No readings in this range',
  className = '',
}) {
  const wrapRef = useRef(null);
  const width = useMeasuredWidth(wrapRef);
  const [hover, setHover] = useState(null); // { t }

  const fmtTime = formatTime || ((ms, o) => new Date(ms).toLocaleString(undefined, o && o.long ? {} : { hour: '2-digit', minute: '2-digit' }));

  // Clean and sort every series once.
  const clean = useMemo(() => series.map((s) => {
    const points = (s.points || [])
      .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    return { ...s, points, gap: medianGap(points) };
  }), [series]);

  const hasData = clean.some((s) => s.points.length > 0);

  // x domain
  const [x0, x1] = useMemo(() => {
    if (Array.isArray(domain) && domain.length === 2 && domain[1] > domain[0]) return domain;
    let lo = Infinity, hi = -Infinity;
    clean.forEach((s) => s.points.forEach((p) => { if (p.t < lo) lo = p.t; if (p.t > hi) hi = p.t; }));
    if (!Number.isFinite(lo)) return [0, 1];
    if (hi === lo) hi = lo + 1;
    return [lo, hi];
  }, [clean, domain]);

  // Panels: one per unit in first-seen order.
  const panels = useMemo(() => {
    const byUnit = new Map();
    clean.forEach((s) => {
      const u = s.unit || '';
      if (!byUnit.has(u)) byUnit.set(u, []);
      byUnit.get(u).push(s);
    });
    return Array.from(byUnit.entries()).map(([unit, list]) => {
      const values = [];
      list.forEach((s) => s.points.forEach((p) => values.push(p.v)));
      const [yMin, yMax] = values.length ? yDomain(values) : [0, 1];
      return { unit, series: list, yMin, yMax, ...yTicks(yMin, yMax, 6) };
    });
  }, [clean]);

  // Union of timestamps for crosshair snapping.
  const allTimes = useMemo(() => {
    const set = new Set();
    clean.forEach((s) => s.points.forEach((p) => set.add(p.t)));
    return Array.from(set).sort((a, b) => a - b).map((t) => ({ t }));
  }, [clean]);

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const xScale = (t) => MARGIN.left + ((t - x0) / (x1 - x0)) * plotW;
  const panelTop = (i) => MARGIN.top + i * (panelHeight + MARGIN.gap);
  const totalH = panels.length > 0
    ? panelTop(panels.length - 1) + panelHeight + MARGIN.xAxis
    : panelHeight + MARGIN.xAxis;

  // x ticks: count by width, evenly spaced across the domain.
  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.min(8, Math.floor(plotW / 96)));
    const out = [];
    for (let i = 0; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n);
    return out;
  }, [plotW, x0, x1]);

  useEffect(() => { setHover(null); }, [series]);

  const onPointer = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < MARGIN.left - 8 || px > rect.width - MARGIN.right + 8 || allTimes.length === 0) { setHover(null); return; }
    const t = x0 + ((px - MARGIN.left) / plotW) * (x1 - x0);
    const snap = nearest(allTimes, t);
    setHover(snap ? { t: snap.t } : null);
  };

  // Readout rows at the hovered time.
  const readout = useMemo(() => {
    if (!hover) return null;
    const rows = clean.map((s) => {
      const p = nearest(s.points, hover.t);
      const tol = Number.isFinite(s.gap) ? s.gap * 1.5 : Infinity;
      const ok = p && Math.abs(p.t - hover.t) <= tol;
      return { key: s.key, label: s.label, unit: s.unit, tone: s.tone, value: ok ? p.v : null, t: ok ? p.t : null };
    });
    return { t: hover.t, rows };
  }, [hover, clean]);

  const hoverX = hover ? xScale(hover.t) : null;
  const flip = hoverX !== null && hoverX > MARGIN.left + plotW * 0.6;

  return (
    <div ref={wrapRef} className={`relative w-full ${className}`.trim()}>
      {/* legend: line key + label + unit; identity never colour-alone */}
      {clean.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-xs text-ink" aria-label="Series">
          {clean.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`inline-block w-3 h-0.5 rounded-full ${toneOf(s.tone).bg}`} />
              <span>{s.label}</span>
              {s.unit && <span className="font-mono tabular text-muted">{s.unit}</span>}
            </li>
          ))}
        </ul>
      )}

      {!hasData ? (
        <div className="flex items-center justify-center text-sm text-muted" style={{ height: panelHeight }}>{emptyText}</div>
      ) : width > 0 && (
        <svg
          width={width}
          height={totalH}
          viewBox={`0 0 ${width} ${totalH}`}
          className="block select-none"
          style={{ touchAction: 'pan-y' }}
          role="img"
          aria-label={clean.map((s) => s.label).join(', ')}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setHover(null)}
        >
          {panels.map((panel, pi) => {
            const top = panelTop(pi);
            const yScale = (v) => top + panelHeight - ((v - panel.yMin) / (panel.yMax - panel.yMin)) * panelHeight;
            const last = pi === panels.length - 1;
            // direct end labels, nudged apart when they collide
            const ends = panel.series
              .filter((s) => s.points.length > 0)
              .map((s) => { const p = s.points[s.points.length - 1]; return { key: s.key, label: s.label, y: yScale(p.v), x: xScale(p.t), v: p.v }; })
              .sort((a, b) => a.y - b.y);
            for (let i = 1; i < ends.length; i++) {
              if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
            }
            return (
              <g key={panel.unit || `panel-${pi}`}>
                {/* unit label, top-left of the panel */}
                <text x={MARGIN.left} y={top - 8} className="fill-muted font-mono tabular" fontSize="10">{panel.unit || 'value'}</text>
                {/* y grid + ticks */}
                {panel.ticks.map((v) => (
                  <g key={v}>
                    <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={yScale(v)} y2={yScale(v)} className="stroke-line" strokeWidth="1" />
                    <text x={MARGIN.left - 8} y={yScale(v) + 3.5} textAnchor="end" fontSize="10" className="fill-muted font-mono tabular">{formatTick(v, panel.step)}</text>
                  </g>
                ))}
                {/* axes */}
                <line x1={MARGIN.left} x2={MARGIN.left} y1={top} y2={top + panelHeight} className="stroke-line" strokeWidth="1" />
                <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={top + panelHeight} y2={top + panelHeight} className="stroke-line" strokeWidth="1" />
                {/* x ticks (labels on the last panel only) */}
                {xTicks.map((t, i) => (
                  <g key={i}>
                    <line x1={xScale(t)} x2={xScale(t)} y1={top + panelHeight} y2={top + panelHeight + 4} className="stroke-line" strokeWidth="1" />
                    {last && (
                      <text
                        x={xScale(t)}
                        y={top + panelHeight + 17}
                        fontSize="10"
                        textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
                        className="fill-muted font-mono tabular"
                      >
                        {fmtTime(t, { long: false })}
                      </text>
                    )}
                  </g>
                ))}
                {/* series lines, broken across gaps > 3x the median step */}
                {panel.series.map((s) => {
                  const segs = [];
                  let cur = [];
                  s.points.forEach((p, i) => {
                    if (i > 0 && p.t - s.points[i - 1].t > s.gap * 3) { segs.push(cur); cur = []; }
                    if (p.t >= x0 && p.t <= x1) cur.push(p);
                  });
                  segs.push(cur);
                  const d = segs
                    .filter((seg) => seg.length > 0)
                    .map((seg) => seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(1)} ${yScale(p.v).toFixed(1)}`).join(' '))
                    .join(' ');
                  const lonely = segs.filter((seg) => seg.length === 1).flat();
                  return (
                    <g key={s.key} className={toneOf(s.tone).stroke}>
                      <path d={d} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                      {lonely.map((p) => (
                        <circle key={p.t} cx={xScale(p.t)} cy={yScale(p.v)} r="2.5" className={toneOf(s.tone).fill} stroke="none" />
                      ))}
                    </g>
                  );
                })}
                {/* direct end labels (ink, never the series colour) */}
                {panel.series.length > 1 && ends.map((e) => (
                  <text key={e.key} x={Math.min(e.x, MARGIN.left + plotW) - 4} y={e.y - 5} textAnchor="end" fontSize="10" className="fill-ink font-sans">{e.label}</text>
                ))}
                {/* hover markers */}
                {readout && readout.rows.filter((r) => r.value !== null && (r.unit || '') === panel.unit).map((r) => (
                  <circle key={r.key} cx={xScale(r.t)} cy={yScale(r.value)} r="4" className={`${toneOf(r.tone).fill} stroke-panel`} strokeWidth="2" />
                ))}
              </g>
            );
          })}
          {hoverX !== null && (
            <line x1={hoverX} x2={hoverX} y1={MARGIN.top - 4} y2={totalH - MARGIN.xAxis} className="stroke-muted" strokeWidth="1" />
          )}
        </svg>
      )}

      {readout && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-panel px-2.5 py-2 text-xs shadow-sm"
          style={flip ? { right: Math.max(0, width - hoverX + 10) } : { left: hoverX + 10 }}
          role="status"
        >
          <div className="font-mono tabular text-muted mb-1">{fmtTime(readout.t, { long: true })}</div>
          {readout.rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2 leading-5">
              <span aria-hidden="true" className={`inline-block w-3 h-0.5 rounded-full ${toneOf(r.tone).bg}`} />
              <span className="font-mono tabular text-ink min-w-[3.5rem] text-right">
                {r.value === null ? '—' : r.value.toFixed(precision)}
              </span>
              <span className="text-muted">{r.unit}</span>
              <span className="text-muted">{r.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { TONE as CHART_TONES };

'use client';
import { formatDateUK, formatGBP } from '@retail/shared';
import { useState } from 'react';

/** Rounded "nice" axis maximum and 4 ticks. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const step = Math.pow(10, Math.floor(Math.log10(max / 4)));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => s * 4 >= max) ?? step * 10;
  return [0, 1, 2, 3, 4].map((i) => i * nice);
}

const shortGBP = (p: number) => (p >= 100000 ? `£${(p / 100000).toFixed(p % 100000 === 0 ? 0 : 1)}k` : `£${Math.round(p / 100)}`);

/**
 * Daily sales columns. Single series in brand teal; columns ≤24px with 4px
 * rounded tops, recessive grid, hover/focus tooltip and an equivalent table
 * for screen readers.
 */
export function DailyColumns({ data, label }: { data: { date: string; value: number; sub?: string }[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 240, pl = 44, pr = 8, pt = 16, pb = 28;
  const ticks = niceTicks(Math.max(...data.map((d) => d.value), 0));
  const top = ticks[ticks.length - 1] || 1;
  const band = (W - pl - pr) / Math.max(data.length, 1);
  const bw = Math.min(24, band * 0.62);
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / top);
  const h = hover !== null ? data[hover] : null;

  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pl} x2={W - pr} y1={y(t)} y2={y(t)} stroke="#E2E8F0" strokeWidth={1} />
            <text x={pl - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[#64748B] text-[11px] tabular">{shortGBP(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pl + band * i + (band - bw) / 2;
          const yy = y(d.value), hh = Math.max(H - pb - yy, d.value > 0 ? 2 : 0);
          const r = Math.min(4, hh / 2, bw / 2);
          const active = hover === i;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} role="graphics-symbol"
              aria-label={`${formatDateUK(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${formatGBP(d.value)}`}>
              <rect x={pl + band * i} y={pt} width={band} height={H - pt - pb} fill={active ? '#F1F5F9' : 'transparent'} />
              <path d={`M${x},${H - pb} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${H - pb} Z`}
                fill={active ? '#095854' : '#0B6E69'} opacity={hover === null || active ? 1 : 0.55} />
              {(i % Math.ceil(data.length / 7) === 0 || i === data.length - 1) && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="fill-[#64748B] text-[11px]">
                  {formatDateUK(d.date, { day: 'numeric', month: 'short' })}
                </text>
              )}
            </g>
          );
        })}
        <line x1={pl} x2={W - pr} y1={H - pb} y2={H - pb} stroke="#CBD5E1" />
      </svg>
      {h && hover !== null && (
        <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg bg-ink px-3 py-2 text-xs text-white shadow-[var(--shadow-pop)]"
          style={{ left: `${((pl + band * hover + band / 2) / W) * 100}%`, top: `${(y(h.value) / H) * 100}%`, marginTop: -8 }}>
          <p className="text-white/70">{formatDateUK(h.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <p className="text-sm font-semibold tabular">{formatGBP(h.value)}</p>
          {h.sub && <p className="text-white/70 tabular">{h.sub}</p>}
        </div>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead><tr><th>Date</th><th>Sales</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.date}><td>{formatDateUK(d.date)}</td><td>{formatGBP(d.value)}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

/** Ranked horizontal bars with the value at the tip (text in ink, mark in teal). */
export function RankBars({ rows, format = formatGBP }: { rows: { label: string; value: number; sub?: string }[]; format?: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ol className="space-y-3">
      {rows.map((r, i) => (
        <li key={r.label} className="group">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate"><span className="mr-2 text-subtle tabular">{i + 1}</span>{r.label}</span>
            <span className="shrink-0 font-medium tabular">{format(r.value)}{r.sub && <span className="ml-1.5 font-normal text-subtle">{r.sub}</span>}</span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-surface" aria-hidden>
            <div className="h-2 rounded-full bg-brand transition-[width] duration-500" style={{ width: `${Math.max((r.value / max) * 100, 2)}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export const nf = new Intl.NumberFormat('es', { maximumFractionDigits: 2 });
const cf = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 });

export const AGGS = { sum: 'Suma', avg: 'Promedio', count: 'Conteo', distinct: 'Únicos', min: 'Mínimo', max: 'Máximo', median: 'Mediana' };

export function fmt(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '—';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v !== 'number') return String(v);
  return Math.abs(v) >= 1e6 ? cf.format(v) : nf.format(v);
}

export const fmtDate = d => d.toLocaleDateString('es', { year: 'numeric', month: '2-digit', day: '2-digit' });

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function aggregate(rows, col, fn) {
  if (fn === 'count' && !col) return rows.length;
  const vals = [];
  for (const r of rows) { const v = r[col]; if (v != null) vals.push(v); }
  if (fn === 'count') return vals.length;
  if (fn === 'distinct') return new Set(vals.map(v => (v instanceof Date ? v.getTime() : v))).size;
  const nums = vals.filter(v => typeof v === 'number');
  if (!nums.length) return null;
  if (fn === 'median') return quantile(nums.sort((a, b) => a - b), 0.5);
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of nums) { sum += v; if (v < min) min = v; if (v > max) max = v; }
  return { sum, avg: sum / nums.length, min, max }[fn] ?? null;
}

// Agrupa por una columna y agrega; devuelve [[clave, valor], ...] de mayor a menor.
export function groupBy(rows, x, y, fn, limit = 15) {
  const m = new Map();
  for (const r of rows) {
    const k = r[x] == null ? '(vacío)' : String(r[x]);
    let a = m.get(k); if (!a) m.set(k, a = []); a.push(r);
  }
  const out = [...m].map(([k, rs]) => [k, aggregate(rs, y, fn), rs]);
  out.sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity));
  if (out.length <= limit) return out.map(([k, v]) => [k, v]);
  const top = out.slice(0, limit - 1).map(([k, v]) => [k, v]);
  const rest = out.slice(limit - 1).flatMap(a => a[2]);
  return [...top, ['Otros', aggregate(rest, y, fn)]];
}

export function timeSeries(rows, dcol, y, fn) {
  let min = Infinity, max = -Infinity;
  for (const r of rows) { const t = r[dcol]?.getTime?.(); if (t == null) continue; if (t < min) min = t; if (t > max) max = t; }
  if (min === Infinity) return [];
  const span = (max - min) / 864e5;
  const gran = span > 3 * 365 ? 'year' : span > 90 ? 'month' : 'day';
  const pad = n => String(n).padStart(2, '0');
  const key = d => gran === 'year' ? `${d.getFullYear()}` : gran === 'month' ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const m = new Map();
  for (const r of rows) { const d = r[dcol]; if (!(d instanceof Date)) continue; const k = key(d); let a = m.get(k); if (!a) m.set(k, a = []); a.push(r); }
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, rs]) => [k, aggregate(rs, y, fn)]);
}

export function histogram(rows, col, bins = 12) {
  const v = []; for (const r of rows) if (typeof r[col] === 'number') v.push(r[col]);
  if (!v.length) return null;
  let min = Infinity, max = -Infinity; for (const x of v) { if (x < min) min = x; if (x > max) max = x; }
  if (min === max) return { labels: [fmt(min)], counts: [v.length] };
  const w = (max - min) / bins, counts = new Array(bins).fill(0);
  for (const x of v) counts[Math.min(bins - 1, Math.floor((x - min) / w))]++;
  return { labels: counts.map((_, i) => `${fmt(min + i * w)}–${fmt(min + (i + 1) * w)}`), counts };
}

export function pearson(rows, a, b, maxN = 20000) {
  const step = Math.max(1, Math.floor(rows.length / maxN));
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < rows.length; i += step) {
    const x = rows[i][a], y = rows[i][b];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 5) return null;
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den ? (n * sab - sa * sb) / den : null;
}

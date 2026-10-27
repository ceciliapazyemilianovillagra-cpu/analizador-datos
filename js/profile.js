import { quantile, fmt, pearson, timeSeries } from './calc.js';

const ID_NAME = /(^|[^a-záéíóúñ])(id|dni|cuil|cuit|legajo|c[oó]digo|nro|n[uú]mero|tel[eé]fono|celular|cp|matr[ií]cula)([^a-záéíóúñ]|$)/i;

export function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^\$\s?|\s?%$/g, '');
  if (/^0\d+/.test(s)) return null; // códigos con ceros a la izquierda
  if (/^-?[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  if (/^-?\d+([.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  return null;
}

export function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s); // día primero
  if (m) return mk(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  return null;
}
function mk(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

function inferType(name, vals) {
  const m = vals.length;
  if (!m) return 'empty';
  let nd = 0, nn = 0;
  for (const v of vals) { if (toDate(v)) nd++; else if (toNum(v) != null) nn++; }
  const distinct = new Set(vals.map(v => (v instanceof Date ? v.getTime() : v))).size;
  if (nd / m >= 0.9) return 'date';
  if (nn / m >= 0.9) {
    const nums = vals.map(toNum).filter(x => x != null);
    const int = nums.every(Number.isInteger);
    const min = Math.min(...nums.slice(0, 50000)), max = Math.max(...nums.slice(0, 50000));
    if (ID_NAME.test(name) && int && distinct / m > 0.5) return 'id';
    if (int && min >= 1900 && max <= 2100 && distinct <= 40) return 'category'; // años
    if (int && distinct <= 8 && m >= 30) return 'category';
    return 'number';
  }
  const avgLen = vals.slice(0, 2000).reduce((s, v) => s + String(v).length, 0) / Math.min(m, 2000);
  if (m > 20 && distinct / m > 0.9) return avgLen > 40 ? 'text' : 'id';
  if (distinct <= 100) return 'category';
  return avgLen > 40 ? 'text' : 'text';
}

export function buildDataset(raw) {
  const { headers } = raw;
  const colsRaw = headers.map((_, j) => raw.rows.map(r => r[j] ?? null));
  const cols = headers.map((name, j) => {
    const vals = colsRaw[j].filter(v => v != null);
    const type = inferType(name, vals);
    const conv = type === 'number' || type === 'id' && typeof vals[0] === 'number' ? toNum
      : type === 'date' ? toDate
        : v => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? v : String(v));
    colsRaw[j] = colsRaw[j].map(v => (v == null ? null : conv(v)));
    return { name, idx: j, type };
  });
  const rows = raw.rows.map((_, i) => { const o = {}; for (let j = 0; j < cols.length; j++) o[cols[j].name] = colsRaw[j][i]; return o; });
  const n = rows.length;
  for (const c of cols) {
    const vals = colsRaw[c.idx].filter(v => v != null);
    c.n = vals.length; c.nulls = n - vals.length; c.nullPct = n ? c.nulls / n : 0;
    c.distinct = new Set(vals.map(v => (v instanceof Date ? v.getTime() : v))).size;
    if (c.type === 'number') {
      const s = vals.slice().sort((a, b) => a - b);
      let sum = 0; for (const v of s) sum += v;
      const mean = sum / s.length;
      let sq = 0; for (const v of s) sq += (v - mean) ** 2;
      const q1 = quantile(s, .25), q3 = quantile(s, .75), iqr = q3 - q1;
      c.stats = {
        sum, mean, min: s[0], max: s[s.length - 1], median: quantile(s, .5), std: Math.sqrt(sq / s.length), q1, q3,
        outliers: iqr > 0 ? s.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr).length : 0,
      };
    } else if (c.type === 'date') {
      let mn = Infinity, mx = -Infinity;
      for (const v of vals) { const t = v.getTime(); if (t < mn) mn = t; if (t > mx) mx = t; }
      c.stats = { min: new Date(mn), max: new Date(mx) };
    } else if (c.type === 'category') {
      const m = new Map(); for (const v of vals) m.set(String(v), (m.get(String(v)) || 0) + 1);
      c.cats = [...m].sort((a, b) => b[1] - a[1]);
    }
  }
  return { name: raw.name, cols, colMap: Object.fromEntries(cols.map(c => [c.name, c])), rows, nRows: n };
}

// Análisis automático: calidad de datos y hallazgos con reglas.
export function analyze(ds) {
  const quality = [], insights = [];
  const { rows, cols } = ds;
  if (rows.length <= 200000) {
    const seen = new Set(); let dup = 0;
    for (const r of rows) { const k = JSON.stringify(cols.map(c => r[c.name])); if (seen.has(k)) dup++; else seen.add(k); }
    if (dup) quality.push(`${fmt(dup)} filas duplicadas (${(dup / rows.length * 100).toFixed(1)}%).`);
  }
  for (const c of cols) {
    if (c.type === 'empty') quality.push(`«${c.name}» está vacía.`);
    else if (c.nullPct > 0.3) quality.push(`«${c.name}» tiene ${(c.nullPct * 100).toFixed(0)}% de valores vacíos.`);
    else if (c.distinct === 1 && rows.length > 1) quality.push(`«${c.name}» tiene un único valor constante.`);
    if (c.type === 'number' && c.stats.outliers / Math.max(1, c.n) > 0.01)
      quality.push(`«${c.name}» tiene ${fmt(c.stats.outliers)} valores atípicos (fuera de 1,5×IQR).`);
  }
  if (!quality.length) quality.push('No se detectaron problemas evidentes de calidad.');

  for (const c of cols.filter(c => c.type === 'category' && c.cats.length > 1 && c.nullPct < .5)) {
    const share = c.cats[0][1] / c.n;
    if (share > 0.5) insights.push(`En «${c.name}», «${c.cats[0][0]}» concentra el ${(share * 100).toFixed(0)}% de los registros.`);
  }
  const nums = cols.filter(c => c.type === 'number').slice(0, 12);
  const corr = [];
  for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) {
    const r = pearson(rows, nums[i].name, nums[j].name);
    if (r != null && Math.abs(r) >= 0.6) corr.push([nums[i].name, nums[j].name, r]);
  }
  corr.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
  for (const [a, b, r] of corr.slice(0, 3)) insights.push(`«${a}» y «${b}» están ${r > 0 ? 'positiva' : 'negativamente'} correlacionadas (r = ${r.toFixed(2)}).`);
  const d = cols.find(c => c.type === 'date'), meas = nums[0];
  if (d && meas) {
    const ts = timeSeries(rows, d.name, meas.name, 'sum');
    if (ts.length >= 4) {
      const h = Math.floor(ts.length / 2);
      const a = ts.slice(0, h).reduce((s, x) => s + (x[1] || 0), 0) / h;
      const b = ts.slice(-h).reduce((s, x) => s + (x[1] || 0), 0) / h;
      if (a && Math.abs(b / a - 1) > 0.1) insights.push(`«${meas.name}» ${b > a ? 'crece' : 'baja'} ${Math.abs((b / a - 1) * 100).toFixed(0)}% entre la primera y la segunda mitad del período de «${d.name}».`);
    }
  }
  if (!insights.length) insights.push('No se encontraron patrones fuertes con las reglas automáticas; probá la propuesta con Gemini.');
  return { quality, insights };
}

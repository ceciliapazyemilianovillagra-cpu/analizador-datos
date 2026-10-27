import { AGGS, pearson } from './calc.js';
import { buildPrompt } from './prompt.js';

const CHARTS = ['bar', 'hbar', 'line', 'pie', 'hist', 'scatter'];
const TABLES = ['top', 'stats', 'data'];
const SUM_NAME = /(total|monto|importe|cantidad|cant\b|venta|ingreso|gasto|costo|deuda|pago|cuota|inscri|matr[ií]cula)/i;

export const defaultAgg = name => (SUM_NAME.test(name) ? 'sum' : 'avg');
export const aggLabel = (agg, col) => (agg === 'count' && !col ? 'Registros' : `${AGGS[agg]} de ${col}`);

const catScore = c => [(c.distinct >= 3 && c.distinct <= 12 ? 0 : 1), c.nullPct];

export function suggestRules(ds) {
  const meas = ds.cols.filter(c => c.type === 'number').sort((a, b) => a.nullPct - b.nullPct).slice(0, 4);
  const cats = ds.cols.filter(c => c.type === 'category' && c.distinct >= 2 && c.distinct <= 30 && c.nullPct < .4)
    .sort((a, b) => { const x = catScore(a), y = catScore(b); return x[0] - y[0] || x[1] - y[1]; }).slice(0, 4);
  const date = ds.cols.find(c => c.type === 'date');
  const ids = ds.cols.find(c => c.type === 'id');
  const spec = { kpis: [], charts: [], tables: [], filters: [], insights: [], summary: '' };
  const m0 = meas[0];

  spec.kpis.push({ label: 'Registros', agg: 'count', col: null });
  if (ids) spec.kpis.push({ label: `${ids.name} únicos`, agg: 'distinct', col: ids.name });
  for (const m of meas.slice(0, 3)) { const a = defaultAgg(m.name); spec.kpis.push({ label: `${a === 'sum' ? 'Total' : 'Promedio'} ${m.name}`, agg: a, col: m.name }); }

  cats.slice(0, 2).forEach((c, i) => {
    const y = i === 0 || !m0 ? m0?.name : m0.name, agg = y ? defaultAgg(y) : 'count';
    spec.charts.push({ type: c.distinct > 8 ? 'hbar' : 'bar', x: c.name, y: y || null, agg, why: `Compara ${y || 'la cantidad de registros'} entre las categorías de «${c.name}».` });
  });
  if (m0 && cats[0]) spec.charts.push({ type: 'hbar', x: cats[0].name, y: null, agg: 'count', why: `Cuántos registros hay en cada «${cats[0].name}».` });
  const small = c => c.distinct >= 2 && c.distinct <= 6;
  const pie = cats.find(c => small(c) && c !== cats[0]) || (cats[1] ? null : cats.find(small));
  if (pie) spec.charts.push({ type: 'pie', x: pie.name, y: null, agg: 'count', why: `Proporción de registros por «${pie.name}».` });
  if (date) spec.charts.push({ type: 'line', x: date.name, y: m0?.name || null, agg: m0 ? defaultAgg(m0.name) : 'count', why: `Evolución en el tiempo según «${date.name}».` });
  for (const m of meas.slice(0, 2)) spec.charts.push({ type: 'hist', x: m.name, y: null, agg: 'count', why: `Cómo se distribuyen los valores de «${m.name}».` });
  let best = null;
  for (let i = 0; i < meas.length; i++) for (let j = i + 1; j < meas.length; j++) {
    const r = pearson(ds.rows, meas[i].name, meas[j].name);
    if (r != null && (!best || Math.abs(r) > Math.abs(best[2]))) best = [meas[i].name, meas[j].name, r];
  }
  if (best && Math.abs(best[2]) >= .3) spec.charts.push({ type: 'scatter', x: best[0], y: best[1], agg: 'avg', why: `Relación entre «${best[0]}» y «${best[1]}» (r = ${best[2].toFixed(2)}).` });

  if (cats[0] && m0) spec.tables.push({ type: 'top', x: cats[0].name, y: m0.name, agg: defaultAgg(m0.name) });
  else if (cats[0]) spec.tables.push({ type: 'top', x: cats[0].name, y: null, agg: 'count' });
  if (meas.length) spec.tables.push({ type: 'stats' });
  spec.tables.push({ type: 'data' });

  if (date) spec.filters.push({ col: date.name });
  cats.forEach(c => spec.filters.push({ col: c.name }));
  meas.slice(0, 2).forEach(c => spec.filters.push({ col: c.name }));
  return finalize(spec, ds);
}

// Valida una propuesta (propia o de la IA): descarta lo que no cuadra con las columnas reales.
export function finalize(spec, ds) {
  const col = n => ds.colMap[n];
  const num = n => col(n)?.type === 'number';
  const okAgg = a => a in AGGS;
  const out = { kpis: [], charts: [], tables: [], filters: [], insights: (spec.insights || []).map(String).slice(0, 8), summary: String(spec.summary || '') };
  let id = 0;
  for (const k of spec.kpis || []) {
    if (!okAgg(k.agg)) continue;
    const c = k.col && col(k.col) ? k.col : null;
    if (k.agg === 'count') { out.kpis.push({ ...k, col: c }); continue; }
    if (!c || (k.agg !== 'distinct' && !num(c))) continue;
    out.kpis.push({ label: k.label || aggLabel(k.agg, c), agg: k.agg, col: c });
  }
  for (const c of spec.charts || []) {
    if (!CHARTS.includes(c.type) || !col(c.x)) continue;
    const xt = col(c.x).type;
    let { type } = c, y = c.y && col(c.y) ? c.y : null, agg = okAgg(c.agg) ? c.agg : (y ? defaultAgg(y) : 'count');
    if (y && agg !== 'count' && !num(y)) y = null, agg = 'count';
    if (type === 'line' && xt !== 'date') type = xt === 'category' ? 'bar' : null;
    if (type === 'hist' && xt !== 'number') type = null;
    if (type === 'scatter' && !(xt === 'number' && y && num(y))) type = null;
    if (['bar', 'hbar', 'pie'].includes(type) && xt === 'date') type = 'line';
    if (['bar', 'hbar', 'pie'].includes(type) && !['category', 'id', 'text'].includes(xt)) type = null;
    if (!type) continue;
    if (type === 'pie' || type === 'hist') { y = null; agg = 'count'; }
    out.charts.push({ type, x: c.x, y, agg, why: c.why || c.title || '' });
  }
  for (const t of spec.tables || []) {
    if (!TABLES.includes(t.type)) continue;
    if (t.type === 'top') {
      if (!col(t.x)) continue;
      let y = t.y && num(t.y) ? t.y : null;
      out.tables.push({ type: 'top', x: t.x, y, agg: y ? (okAgg(t.agg) ? t.agg : defaultAgg(y)) : 'count' });
    } else out.tables.push({ type: t.type });
  }
  const seen = new Set();
  const addFilter = n => { const c = col(n); if (c && ['category', 'date', 'number'].includes(c.type) && !seen.has(n)) { seen.add(n); out.filters.push({ col: n }); } };
  (spec.filters || []).forEach(f => addFilter(f.col));
  out.charts.forEach(c => col(c.x).type === 'category' && addFilter(c.x));
  out.kpis = out.kpis.slice(0, 8); out.charts = out.charts.slice(0, 12); out.tables = out.tables.slice(0, 4); out.filters = out.filters.slice(0, 8);
  for (const list of [out.kpis, out.charts, out.tables, out.filters]) for (const it of list) { it.id = 'i' + id++; it.on = true; }
  return out;
}

/* ---------- Gemini ---------- */

export function profileForAI(ds, withValues) {
  return {
    hoja: ds.name, filas: ds.nRows,
    columnas: ds.cols.map(c => {
      const o = { nombre: c.name, tipo: c.type, vacios_pct: +(c.nullPct * 100).toFixed(1), distintos: c.distinct };
      if (c.type === 'number') Object.assign(o, { min: c.stats.min, max: c.stats.max, media: +c.stats.mean.toFixed(2), mediana: c.stats.median });
      if (c.type === 'date') Object.assign(o, { desde: c.stats.min.toISOString().slice(0, 10), hasta: c.stats.max.toISOString().slice(0, 10) });
      if (c.type === 'category' && withValues) o.valores_frecuentes = c.cats.slice(0, 8).map(a => a[0]);
      return o;
    }),
  };
}

export async function askGemini(key, model, ds, withValues) {
  const prompt = buildPrompt(profileForAI(ds, withValues));
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error?.message || `Error ${res.status}`);
    err.status = res.status;
    const retry = JSON.stringify(body).match(/"retryDelay":\s*"(\d+)/);
    err.retrySec = retry ? +retry[1] : null;
    throw err;
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return parseSpec(text, ds);
}

function parseSpec(text, ds) {
  try { return finalize(JSON.parse(text.replace(/^```json|```$/g, '')), ds); }
  catch { throw new Error('Gemini devolvió una respuesta que no se pudo interpretar. Probá de nuevo.'); }
}

/* ---------- Gemini con la clave del sitio (/api/ai) ---------- */

// Devuelve el estado del cupo compartido, o null si el sitio no ofrece IA compartida.
export async function sharedStatus() {
  try {
    const r = await fetch('/api/ai', { cache: 'no-store' });
    if (!r.ok) return null;
    const s = await r.json();
    return s.enabled ? s : null;
  } catch { return null; }
}

export async function askShared(ds, withValues) {
  const res = await fetch('/api/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: profileForAI(ds, withValues) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Error ${res.status}`);
    err.status = res.status; err.shared = body;
    throw err;
  }
  return parseSpec(body.text || '', ds);
}

/* ---------- Contador de usos de IA (por navegador) ---------- */

const KEY = 'ad.ai.usage';
const DEFAULTS = { rpm: 10, rpd: 250 };

// Google reinicia el cupo diario a medianoche, hora del Pacífico.
const dayKey = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(t);

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* sin almacenamiento */ } }

export const usage = {
  limits() { const s = load(); return { rpm: s.rpm || DEFAULTS.rpm, rpd: s.rpd || DEFAULTS.rpd }; },
  setLimits(rpm, rpd) { const s = load(); s.rpm = Math.max(1, +rpm || DEFAULTS.rpm); s.rpd = Math.max(1, +rpd || DEFAULTS.rpd); save(s); },
  record() {
    const s = load(), now = Date.now();
    s.calls = [...(s.calls || []).filter(t => dayKey(t) === dayKey(now)), now];
    save(s);
  },
  // Próximo reinicio del cupo diario (medianoche del Pacífico), en hora local.
  nextReset() {
    const now = Date.now(), k = dayKey(now);
    for (let m = 1; m <= 1500; m++) if (dayKey(now + m * 60000) !== k) return new Date(now + m * 60000);
    return null;
  },
  block(sec) { const s = load(); s.blockedUntil = Date.now() + sec * 1000; save(s); },
  // Estado actual: cuántos usos lleva y si puede usarla ya.
  status() {
    const s = load(), now = Date.now(), { rpm, rpd } = this.limits();
    const today = (s.calls || []).filter(t => dayKey(t) === dayKey(now));
    const lastMin = today.filter(t => now - t < 60000);
    let waitSec = 0, reason = '';
    if (today.length >= rpd) { waitSec = null; reason = 'day'; }
    else if (lastMin.length >= rpm) { waitSec = Math.ceil((lastMin[0] + 60000 - now) / 1000); reason = 'minute'; }
    if (reason !== 'day' && s.blockedUntil > now) { waitSec = Math.max(waitSec || 0, Math.ceil((s.blockedUntil - now) / 1000)); reason = reason || 'blocked'; }
    return { rpm, rpd, usedMin: lastMin.length, usedDay: today.length, waitSec, reason, available: waitSec === 0 };
  },
};

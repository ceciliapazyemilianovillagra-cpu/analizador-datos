// Intermediario con Gemini: la clave vive en variables de entorno y nunca llega al navegador.
// GET  /api/ai  -> estado del cupo compartido
// POST /api/ai  -> { profile } => { text }
import { createHash } from 'node:crypto';
import { buildPrompt } from '../js/prompt.js';

const env = process.env;
const MODEL = env.GEMINI_MODEL || 'gemini-3.8-flash';
const L = {
  rpm: +env.LIMIT_RPM || 10, rpd: +env.LIMIT_RPD || 100,       // cupo de todo el sitio
  ipRpm: +env.LIMIT_IP_RPM || 3, ipRpd: +env.LIMIT_IP_RPD || 10, // cupo por persona
};
const RURL = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
const RTOK = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;

/* ---- almacenamiento de contadores: Redis (Upstash) o memoria si no está configurado ---- */
const mem = new Map();
const memGet = k => { const e = mem.get(k); if (!e) return null; if (e.exp < Date.now()) { mem.delete(k); return null; } return e.v; };
const pipe = async cmds => {
  const r = await fetch(`${RURL}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${RTOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).map(x => x.result);
};
const store = RURL ? {
  mget: keys => pipe(keys.map(k => ['GET', k])),
  incr: (k, ttl) => pipe([['INCR', k], ['EXPIRE', k, ttl]]),
  set: (k, v, ttl) => pipe([['SET', k, String(v), 'EX', ttl]]),
} : {
  async mget(keys) { return keys.map(memGet); },
  async incr(k, ttl) { const v = (+memGet(k) || 0) + 1; mem.set(k, { v, exp: Date.now() + ttl * 1000 }); return [v]; },
  async set(k, v, ttl) { mem.set(k, { v, exp: Date.now() + ttl * 1000 }); },
};

// Google reinicia el cupo diario a medianoche, hora del Pacífico.
const dayKey = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(t);
function nextDayReset(now) {
  const k = dayKey(now);
  for (let m = 1; m <= 1500; m++) if (dayKey(now + m * 60000) !== k) return now + m * 60000;
  return now + 864e5;
}

async function status(ip) {
  const now = Date.now(), mb = Math.floor(now / 60000), day = dayKey(now);
  const [m, d, blk, im, id] = (await store.mget([`ai:m:${mb}`, `ai:d:${day}`, 'ai:blk', `ai:im:${ip}:${mb}`, `ai:id:${ip}:${day}`])).map(v => +v || 0);
  const minResetAt = (mb + 1) * 60000, dayResetAt = nextDayReset(now);
  let reason = '', waitSec = 0;
  if (d >= L.rpd) { reason = 'day'; waitSec = null; }
  else if (id >= L.ipRpd) { reason = 'ip-day'; waitSec = null; }
  else if (m >= L.rpm) { reason = 'minute'; waitSec = Math.ceil((minResetAt - now) / 1000); }
  else if (im >= L.ipRpm) { reason = 'ip-minute'; waitSec = Math.ceil((minResetAt - now) / 1000); }
  if (reason !== 'day' && reason !== 'ip-day' && blk > now) { reason = reason || 'blocked'; waitSec = Math.max(waitSec || 0, Math.ceil((blk - now) / 1000)); }
  return {
    enabled: true, rpm: L.rpm, rpd: L.rpd, usedMin: m, usedDay: d,
    you: { rpm: L.ipRpm, rpd: L.ipRpd, usedMin: im, usedDay: id },
    minResetAt, dayResetAt, blockedUntil: blk, available: reason === '', reason, waitSec,
  };
}

const clientIp = req => {
  const raw = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'x';
  return createHash('sha256').update(raw).digest('hex').slice(0, 16); // no se guarda la IP real
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!env.GEMINI_API_KEY) return res.status(503).json({ enabled: false });
  try {
    const ip = clientIp(req), st = await status(ip);
    if (req.method === 'GET') return res.status(200).json(st);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const p = body.profile;
    if (!p || !Array.isArray(p.columnas) || !p.columnas.length || p.columnas.length > 300 || JSON.stringify(p).length > 60000)
      return res.status(400).json({ error: 'Perfil de tabla inválido o demasiado grande.' });
    if (!st.available) return res.status(429).json({ error: 'Cupo de IA agotado por ahora.', ...st });

    const now = Date.now(), mb = Math.floor(now / 60000), day = dayKey(now);
    await Promise.all([store.incr(`ai:m:${mb}`, 120), store.incr(`ai:d:${day}`, 172800), store.incr(`ai:im:${ip}:${mb}`, 120), store.incr(`ai:id:${ip}:${day}`, 172800)]);

    const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildPrompt(p) }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
      signal: AbortSignal.timeout(25000),
    });
    if (!g.ok) {
      const err = await g.json().catch(() => ({}));
      console.error('gemini', g.status, err.error?.message);
      if (g.status === 429) {
        const sec = +(JSON.stringify(err).match(/"retryDelay":\s*"(\d+)/)?.[1]) || 60;
        await store.set('ai:blk', now + sec * 1000, sec + 5);
        return res.status(429).json({ error: 'Google indicó que se alcanzó el límite. Probá en un momento.', ...(await status(ip)) });
      }
      return res.status(502).json({ error: 'La IA no respondió correctamente. Probá de nuevo.' });
    }
    const data = await g.json();
    const text = data.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '';
    return res.status(200).json({ text });
  } catch (e) {
    console.error('api/ai', e);
    return res.status(503).json({ error: 'El servicio de IA no está disponible ahora.' });
  }
}

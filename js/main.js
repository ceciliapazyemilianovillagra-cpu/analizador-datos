import { readFile } from './parse.js';
import { buildDataset, analyze } from './profile.js';
import { suggestRules, askGemini, askShared, sharedStatus, usage, aggLabel } from './suggest.js';
import { Dashboard } from './dashboard.js';
import { fmt, fmtDate, esc } from './calc.js';

const $ = s => document.querySelector(s);
const main = $('#content');
const app = { file: '', sets: [], cur: 0, view: 'upload', dash: null, timer: null };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};
const TYPES = { number: 'número', date: 'fecha', category: 'categoría', id: 'identificador', text: 'texto', empty: 'vacía' };
const CHART_NAMES = { bar: 'Barras', hbar: 'Barras horizontales', line: 'Líneas', pie: 'Torta', hist: 'Histograma', scatter: 'Dispersión' };
const ds = () => app.sets[app.cur];
const analysis = () => (ds().analysis ||= analyze(ds()));
const spec = () => (ds().spec ||= suggestRules(ds()));

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.tm); toast.tm = setTimeout(() => t.classList.remove('on'), 3200);
}

/* ---------- navegación ---------- */
function go(view) {
  clearInterval(app.timer);
  app.dash?.dispose(); app.dash = null;
  app.view = view;
  ({ upload: viewUpload, analysis: viewAnalysis, proposal: viewProposal, dashboard: viewDashboard })[view]();
  document.querySelectorAll('#steps button').forEach(b => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.disabled = b.dataset.view !== 'upload' && !app.sets.length;
  });
  renderFilebar();
  main.focus({ preventScroll: true }); window.scrollTo(0, 0);
}
$('#steps').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) go(b.dataset.view); });

function renderFilebar() {
  const bar = $('#filebar');
  bar.hidden = !app.sets.length || app.view === 'upload';
  if (bar.hidden) return;
  const sheets = app.sets.length > 1
    ? `<label>Hoja: <select id="sheetSel" style="width:auto;min-height:32px">${app.sets.map((s, i) => `<option value="${i}" ${i === app.cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`
    : `<span>Hoja: <b>${esc(ds().name)}</b></span>`;
  bar.innerHTML = `<span>Archivo: <b>${esc(app.file)}</b></span>${sheets}<span>${fmt(ds().nRows)} filas · ${ds().cols.length} columnas</span><button class="link" id="again">Cargar otro archivo</button>`;
  $('#sheetSel')?.addEventListener('change', e => { app.cur = +e.target.value; go(app.view); });
  $('#again').addEventListener('click', () => go('upload'));
}

/* ---------- 1. carga ---------- */
function viewUpload(error) {
  main.innerHTML = `
    <h1>Subí tu planilla y obtené un dashboard</h1>
    <p class="lede">Excel, CSV, ODS o JSON, con cualquier cantidad de filas y de hojas. Primero se analiza, después se proponen indicadores y gráficos, y al final se arma el dashboard y el reporte.</p>
    <div class="drop" id="drop">
      <p><strong>Arrastrá el archivo acá</strong></p>
      <p>.xlsx · .xls · .ods · .csv · .tsv · .json (no se admiten PDF)</p>
      <button class="btn" id="pick" type="button">Elegir archivo</button>
      <input type="file" id="file" hidden accept=".xlsx,.xls,.xlsm,.ods,.csv,.tsv,.txt,.json">
      ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    </div>
    <div class="notes">
      <div><h3>Tus datos no se suben</h3><p>El archivo se lee y se analiza dentro de tu navegador. No pasa por ningún servidor.</p></div>
      <div><h3>Google Sheets</h3><p>Abrilo, andá a Archivo → Descargar → Excel o CSV, y subí ese archivo.</p></div>
      <div><h3>IA opcional</h3><p>Todo funciona sin IA. Si querés, podés sumar Gemini con tu propia clave gratuita.</p></div>
    </div>`;
  const drop = $('#drop'), input = $('#file');
  $('#pick').onclick = () => input.click();
  input.onchange = () => input.files[0] && handle(input.files[0]);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files[0] && handle(e.dataTransfer.files[0]));
}

async function handle(file) {
  main.innerHTML = `<div class="busy" role="status">Leyendo y analizando «${esc(file.name)}»…</div>`;
  await new Promise(r => setTimeout(r, 30));
  try {
    const tables = await readFile(file);
    if (!tables.length) throw new Error('No encontré ninguna tabla con datos en el archivo.');
    app.sets = [];
    for (const t of tables) { app.sets.push(buildDataset(t)); await new Promise(r => setTimeout(r, 0)); }
    app.file = file.name; app.cur = 0;
    go('analysis');
  } catch (err) {
    console.error(err);
    app.sets = []; viewUpload(err.message || 'No se pudo leer el archivo.');
    document.querySelectorAll('#steps button').forEach(b => { b.disabled = b.dataset.view !== 'upload'; });
  }
}

/* ---------- 2. análisis ---------- */
function viewAnalysis() {
  const d = ds(), a = analysis();
  const cnt = t => d.cols.filter(c => c.type === t).length;
  const nulls = d.cols.reduce((s, c) => s + c.nulls, 0), cells = d.nRows * d.cols.length;
  const summ = c => {
    if (c.type === 'number') return `${fmt(c.stats.min)} – ${fmt(c.stats.max)} · media ${fmt(c.stats.mean)}`;
    if (c.type === 'date') return `${fmtDate(c.stats.min)} → ${fmtDate(c.stats.max)}`;
    if (c.type === 'category') return c.cats.slice(0, 3).map(([v, n]) => `${esc(v)} (${fmt(n)})`).join(' · ');
    return c.type === 'empty' ? '' : `ej.: ${esc(String(d.rows.find(r => r[c.name] != null)?.[c.name] ?? '').slice(0, 40))}`;
  };
  main.innerHTML = `
    <div class="stack">
      <div><h1>Análisis de «${esc(d.name)}»</h1><p class="lede">Lo que encontramos al leer la tabla: estructura, calidad y primeros patrones.</p></div>
      <div class="grid4">
        <div class="card stat"><span>Filas</span><strong>${fmt(d.nRows)}</strong></div>
        <div class="card stat"><span>Columnas</span><strong>${d.cols.length}</strong></div>
        <div class="card stat"><span>Celdas vacías</span><strong>${cells ? (nulls / cells * 100).toFixed(1) : 0}%</strong></div>
        <div class="card stat"><span>Numéricas · Categóricas · Fechas</span><strong>${cnt('number')} · ${cnt('category')} · ${cnt('date')}</strong></div>
      </div>
      <div class="two">
        <section class="card block"><h2>Hallazgos</h2><ul class="list">${a.insights.map(i => `<li>${esc(i)}</li>`).join('')}</ul></section>
        <section class="card block"><h2>Calidad de los datos</h2><ul class="list">${a.quality.map(i => `<li>${esc(i)}</li>`).join('')}</ul></section>
      </div>
      <section class="card block"><h2>Columnas</h2><div class="scroll"><table>
        <thead><tr><th>Columna</th><th>Tipo</th><th>Vacíos</th><th class="n">Distintos</th><th>Resumen</th></tr></thead>
        <tbody>${d.cols.map(c => `<tr><td>${esc(c.name)}</td><td><span class="tag">${TYPES[c.type]}</span></td><td><span class="bar"><i style="width:${Math.round(c.nullPct * 100)}%"></i></span>${(c.nullPct * 100).toFixed(0)}%</td><td class="n">${fmt(c.distinct)}</td><td style="white-space:normal">${summ(c)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card block"><h2>Primeras filas</h2><div class="scroll"><table>
        <thead><tr>${d.cols.map(c => `<th>${esc(c.name)}</th>`).join('')}</tr></thead>
        <tbody>${d.rows.slice(0, 8).map(r => `<tr>${d.cols.map(c => `<td${c.type === 'number' ? ' class="n"' : ''}>${esc(r[c.name] instanceof Date ? fmtDate(r[c.name]) : r[c.name] == null ? '' : c.type === 'number' ? fmt(r[c.name]) : r[c.name])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
      <div><button class="btn" id="next">Ver indicadores propuestos</button></div>
    </div>`;
  $('#next').onclick = () => go('proposal');
}

/* ---------- 3. propuesta + IA ---------- */
function viewProposal() {
  const s = spec(), d = ds();
  const item = (list, it, title, sub) => `<label class="item"><input type="checkbox" data-list="${list}" data-id="${it.id}" ${it.on ? 'checked' : ''}><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></label>`;
  main.innerHTML = `
    <div class="stack">
      <div><h1>Indicadores propuestos</h1><p class="lede">Marcá lo que quieras ver en el dashboard. La propuesta sale de reglas automáticas sobre tus columnas; podés mejorarla con Gemini.</p></div>
      ${s.summary ? `<div class="card block"><h2>Resumen de Gemini</h2><p>${esc(s.summary)}</p></div>` : ''}
      <section class="card ai" id="aiPanel" aria-labelledby="aiT"><p class="lede">Verificando la IA disponible…</p></section>
      <div class="pick">
        <section class="card block"><h2>Indicadores (KPI)</h2>${s.kpis.map(k => item('kpis', k, k.label, aggLabel(k.agg, k.col))).join('') || '<p>Sin indicadores.</p>'}</section>
        <section class="card block"><h2>Filtros</h2>${s.filters.map(f => item('filters', f, f.col, TYPES[d.colMap[f.col].type])).join('') || '<p>Sin filtros.</p>'}</section>
        <section class="card block"><h2>Gráficos</h2>${s.charts.map(c => item('charts', c, `${CHART_NAMES[c.type]}: ${c.type === 'scatter' ? `${c.y} vs ${c.x}` : c.y ? `${aggLabel(c.agg, c.y)} por ${c.x}` : c.type === 'hist' ? `distribución de ${c.x}` : `registros por ${c.x}`}`, c.why)).join('') || '<p>Sin gráficos.</p>'}</section>
        <section class="card block"><h2>Tablas</h2>${s.tables.map(t => item('tables', t, { top: `Ranking por ${t.x}`, stats: 'Estadísticas descriptivas', data: 'Tabla de datos con paginado y orden' }[t.type], '')).join('')}</section>
      </div>
      <div><button class="btn" id="build">Generar dashboard</button></div>
    </div>`;
  $('#build').onclick = () => go('dashboard');
  if (app.shared !== undefined) renderAI(); else app.sharedP.then(renderAI);
  app.tick = 0;
  app.timer = setInterval(() => { meter(); if (app.shared && ++app.tick % 10 === 0) refreshShared(); }, 1000);
}

async function refreshShared() {
  const s = await sharedStatus();
  if (s || app.shared === undefined) app.shared = s;
}

function renderAI() {
  const p = $('#aiPanel'); if (!p || app.view !== 'proposal') return;
  const shared = !!app.shared;
  p.innerHTML = `
    <h2 id="aiT">Mejorar la propuesta con Gemini <span class="tag">${shared ? 'sin clave' : 'opcional'}</span></h2>
    <p class="lede" style="font-size:.9rem">${shared ? 'Usa la IA del sitio, sin que tengas que crear nada. El cupo gratuito se comparte entre todas las personas que usan la página.' : 'Usá tu propia clave gratuita de Google AI Studio.'} A Gemini solo se envían los nombres de las columnas y estadísticas generales, nunca las filas.</p>
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="vals"> Enviar también valores frecuentes de las categorías</label>
    <div class="meter" id="meter" aria-live="polite"></div>
    <div class="row" style="margin-top:14px">${shared ? '<button class="btn" id="ask">Proponer con Gemini</button>' : ''}<button class="btn sec" id="rules">Volver a la propuesta automática</button></div>
    <p id="aiMsg" role="status" style="margin-top:10px"></p>
    <details class="mini" ${shared ? '' : 'open'}><summary>${shared ? 'Usar mi propia clave (si el cupo compartido se agotó)' : 'Mi clave de API y ajustes'}</summary>
      <div class="fields">
        <label>Clave de API <input type="password" id="key" autocomplete="off" spellcheck="false" placeholder="AIza…"></label>
        <label>Modelo <input type="text" id="model" value="${esc(store.get('ad.model') || 'gemini-3.8-flash')}"></label>
        <label class="chk"><input type="checkbox" id="remember" ${store.get('ad.key') ? 'checked' : ''}> Recordar la clave en este navegador</label>
      </div>
      <div class="row" style="margin-top:12px"><button class="btn ${shared ? 'sec' : ''}" id="askOwn">Proponer con mi clave</button><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Conseguir una clave gratis</a></div>
      <div class="fields"><label>Usos por minuto (tu clave) <input type="number" id="rpm" min="1" value="${usage.limits().rpm}"></label><label>Usos por día (tu clave) <input type="number" id="rpd" min="1" value="${usage.limits().rpd}"></label></div>
      <p style="margin-top:8px">Con tu clave, el contador cuenta los usos hechos desde este navegador. Los límites reales dependen de tu cuenta y del modelo, y Google los cambia: ajustalos si hace falta.</p></details>`;
  $('#key').value = store.get('ad.key') || '';
  $('#rules').onclick = () => { ds().spec = suggestRules(ds()); go('proposal'); };
  $('#ask')?.addEventListener('click', () => askAI(false));
  $('#askOwn').onclick = () => askAI(true);
  ['rpm', 'rpd'].forEach(id => $('#' + id).addEventListener('change', () => { usage.setLimits($('#rpm').value, $('#rpd').value); meter(); }));
  meter();
}

function onPick(e) {
  const t = e.target; if (!t.dataset?.list) return;
  const it = spec()[t.dataset.list].find(x => x.id === t.dataset.id); if (it) it.on = t.checked;
}

// Cupo vigente: el compartido del sitio (si existe) o el contador local de la clave propia.
function quota() {
  const s = app.shared;
  if (s) {
    const now = Date.now(), minDone = now >= s.minResetAt, dayDone = now >= s.dayResetAt;
    const uMin = minDone ? 0 : s.usedMin, yMin = minDone ? 0 : s.you.usedMin, uDay = dayDone ? 0 : s.usedDay, yDay = dayDone ? 0 : s.you.usedDay;
    let reason = '', waitSec = 0;
    if (uDay >= s.rpd) { reason = 'day'; waitSec = null; }
    else if (yDay >= s.you.rpd) { reason = 'ip-day'; waitSec = null; }
    else if (uMin >= s.rpm || yMin >= s.you.rpm) { reason = 'minute'; waitSec = Math.max(1, Math.ceil((s.minResetAt - now) / 1000)); }
    if (reason !== 'day' && reason !== 'ip-day' && s.blockedUntil > now) { reason = reason || 'blocked'; waitSec = Math.max(waitSec || 0, Math.ceil((s.blockedUntil - now) / 1000)); }
    return { rows: [['Último minuto (todos)', uMin, s.rpm], ['Hoy (todos)', uDay, s.rpd], ['Tus usos hoy', yDay, s.you.rpd]], available: !reason, reason, waitSec, resetAt: new Date(s.dayResetAt) };
  }
  const u = usage.status();
  return { rows: [['Último minuto', u.usedMin, u.rpm], ['Hoy', u.usedDay, u.rpd]], available: u.available, reason: u.reason, waitSec: u.waitSec, resetAt: usage.nextReset() };
}

function meter() {
  const el = $('#meter'); if (!el) return;
  const q = quota(), pct = (a, b) => Math.min(100, a / b * 100).toFixed(0);
  let cls = '', txt = 'Disponible ahora';
  if (q.reason === 'day' || q.reason === 'ip-day') {
    cls = 'stop';
    const when = q.resetAt ? q.resetAt.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : 'medianoche (Pacífico)';
    txt = `${q.reason === 'ip-day' ? 'Llegaste a tu límite diario' : 'Cupo diario agotado'} · vuelve a las ${when}`;
  } else if (!q.available) { cls = 'wait'; txt = `Esperá ${q.waitSec} s para volver a usarla`; }
  el.innerHTML = q.rows.map(([l, u, m]) => `<div>${l}<strong>${u} / ${m}</strong><div class="track"><i style="width:${pct(u, m)}%"></i></div></div>`).join('')
    + `<div>Estado<strong class="state ${cls}">${txt}</strong></div>`;
  const b = $('#ask'); if (b && !b.dataset.busy) b.disabled = !q.available;
  const o = $('#askOwn'); if (o && !o.dataset.busy) o.disabled = !usage.status().available;
}

async function askAI(own) {
  const msg = $('#aiMsg'), btn = $(own ? '#askOwn' : '#ask'), vals = $('#vals').checked;
  let key, model;
  msg.style.color = '';
  if (own) {
    key = $('#key').value.trim(); model = $('#model').value.trim() || 'gemini-3.8-flash';
    if (!key) { msg.textContent = 'Pegá tu clave de API para usar Gemini.'; return; }
    if (!usage.status().available) return;
    $('#remember').checked ? store.set('ad.key', key) : store.del('ad.key');
    store.set('ad.model', model);
    usage.record();
  } else if (!quota().available) return;
  btn.dataset.busy = '1'; btn.disabled = true; msg.textContent = 'Consultando a Gemini…'; meter();
  try {
    const out = own ? await askGemini(key, model, ds(), vals) : await askShared(ds(), vals);
    if (!out.kpis.length && !out.charts.length) throw new Error('Gemini no propuso nada utilizable. Probá de nuevo.');
    ds().spec = out; toast('Propuesta de Gemini aplicada'); go('proposal');
  } catch (err) {
    if (err.shared?.minResetAt) app.shared = err.shared;
    if (err.status === 429) {
      if (own) usage.block(err.retrySec || 60);
      msg.textContent = own ? 'Google indicó que se alcanzó el límite. Esperá un momento y probá de nuevo.' : 'El cupo compartido está agotado o hay mucha demanda. Esperá un momento o usá tu propia clave.';
    } else if (own && (err.status === 400 || err.status === 403)) msg.textContent = `La clave o el modelo no son válidos (${err.message}).`;
    else msg.textContent = err.message || 'No se pudo consultar a Gemini.';
    msg.style.color = 'var(--bad)';
  } finally {
    delete btn.dataset.busy;
    if (!own) await refreshShared();
    meter();
  }
}

/* ---------- 4. dashboard ---------- */
function viewDashboard() {
  const s = spec(), d = ds();
  const notes = (s.summary ? [s.summary] : []).concat(s.insights.length ? s.insights : analysis().insights);
  main.innerHTML = `
    <div class="print-only"><h1>Reporte: ${esc(d.name)}</h1><p>${esc(app.file)} · ${esc(new Date().toLocaleString('es'))}</p></div>
    <div class="toolbar">
      <div id="summary" aria-live="polite"></div>
      <div class="row no-print"><button class="btn sec" id="back">Editar propuesta</button><button class="btn sec" id="xls">Descargar Excel</button><button class="btn" id="pdf">Imprimir / guardar PDF</button></div>
    </div>
    <div class="dash">
      <aside id="filters" class="no-print" aria-label="Filtros"></aside>
      <div>
        <div id="kpis" class="kpis"></div>
        <section class="card block insights" ${notes.length ? '' : 'hidden'}><h2>Lectura rápida</h2><ul class="list">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></section>
        <div id="charts" class="charts"></div>
        <div id="tables" class="tables"></div>
      </div>
    </div>`;
  app.dash = new Dashboard(d, s, { filters: $('#filters'), kpis: $('#kpis'), charts: $('#charts'), tables: $('#tables'), summary: $('#summary') });
  $('#kpis').hidden = !$('#kpis').children.length;
  $('#back').onclick = () => go('proposal');
  $('#pdf').onclick = () => window.print();
  $('#xls').onclick = () => { app.dash.exportExcel(`reporte-${d.name.replace(/[^\w-]+/g, '_')}.xlsx`); toast('Excel generado'); };
}

main.addEventListener('change', onPick);
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => app.dash?.resize(), 150); });
window.addEventListener('beforeprint', () => app.dash?.resize());
window.addEventListener('afterprint', () => app.dash?.resize());

app.sharedP = refreshShared(); // ¿el sitio ofrece IA compartida?
go('upload');

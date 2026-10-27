import { readFile } from './parse.js';
import { buildDataset, analyze } from './profile.js';
import { suggestRules, aggLabel } from './suggest.js';
import { Dashboard } from './dashboard.js';
import { fmt, fmtDate, esc } from './calc.js';

const $ = s => document.querySelector(s);
const main = $('#content');
const app = { file: '', sets: [], cur: 0, view: 'upload', dash: null, timer: null };
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
      <div><h3>Reporte listo para usar</h3><p>Imprimí o guardá el dashboard en PDF, o descargá un Excel con los datos filtrados.</p></div>
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

/* ---------- 3. propuesta ---------- */
function viewProposal() {
  const s = spec(), d = ds();
  const item = (list, it, title, sub) => `<label class="item"><input type="checkbox" data-list="${list}" data-id="${it.id}" ${it.on ? 'checked' : ''}><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></label>`;
  main.innerHTML = `
    <div class="stack">
      <div><h1>Indicadores propuestos</h1><p class="lede">Marcá lo que quieras ver en el dashboard. La propuesta sale de reglas automáticas según los tipos de tus columnas.</p></div>
      <div><button class="btn sec" id="rules">Restablecer la propuesta automática</button></div>
      <div class="pick">
        <section class="card block"><h2>Indicadores (KPI)</h2>${s.kpis.map(k => item('kpis', k, k.label, aggLabel(k.agg, k.col))).join('') || '<p>Sin indicadores.</p>'}</section>
        <section class="card block"><h2>Filtros</h2>${s.filters.map(f => item('filters', f, f.col, TYPES[d.colMap[f.col].type])).join('') || '<p>Sin filtros.</p>'}</section>
        <section class="card block"><h2>Gráficos</h2>${s.charts.map(c => item('charts', c, `${CHART_NAMES[c.type]}: ${c.type === 'scatter' ? `${c.y} vs ${c.x}` : c.y ? `${aggLabel(c.agg, c.y)} por ${c.x}` : c.type === 'hist' ? `distribución de ${c.x}` : `registros por ${c.x}`}`, c.why)).join('') || '<p>Sin gráficos.</p>'}</section>
        <section class="card block"><h2>Tablas</h2>${s.tables.map(t => item('tables', t, { top: `Ranking por ${t.x}`, stats: 'Estadísticas descriptivas', data: 'Tabla de datos con paginado y orden' }[t.type], '')).join('')}</section>
      </div>
      <div><button class="btn" id="build">Generar dashboard</button></div>
    </div>`;
  $('#build').onclick = () => go('dashboard');
  $('#rules').onclick = () => { ds().spec = suggestRules(ds()); go('proposal'); };
}

function onPick(e) {
  const t = e.target; if (!t.dataset?.list) return;
  const it = spec()[t.dataset.list].find(x => x.id === t.dataset.id); if (it) it.on = t.checked;
}

/* ---------- 4. dashboard ---------- */
function viewDashboard() {
  const s = spec(), d = ds();
  const notes = analysis().insights;
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

go('upload');

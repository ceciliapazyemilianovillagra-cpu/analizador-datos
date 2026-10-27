import { fmt, fmtDate, esc, AGGS, aggregate, groupBy, timeSeries, histogram } from './calc.js';
import { aggLabel } from './suggest.js';

const PAGE = 50;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class Dashboard {
  constructor(ds, spec, els) {
    this.ds = ds; this.spec = spec; this.els = els;
    this.f = {}; this.page = 0; this.sort = null; this.charts = []; this.exports = [];
    for (const { col } of spec.filters) {
      const c = ds.colMap[col];
      this.f[col] = c.type === 'category' ? { kind: 'cat', sel: new Set() } : c.type === 'date' ? { kind: 'date', from: null, to: null } : { kind: 'num', min: null, max: null };
    }
    this.buildFilters();
    this.buildCards();
    els.filters.addEventListener('input', e => this.onFilter(e));
    els.filters.addEventListener('click', e => { if (e.target.closest('[data-reset]')) this.reset(); });
    els.tables.addEventListener('click', e => this.onTable(e));
    this.update();
  }

  /* ---- filtros ---- */
  buildFilters() {
    const h = [`<div class="flt-head"><h2>Filtros</h2><button type="button" class="link" data-reset>Limpiar</button></div>`];
    for (const { col } of this.spec.filters) {
      const c = this.ds.colMap[col], s = esc(col);
      if (c.type === 'category') {
        h.push(`<details class="flt" open><summary>${s}<span class="badge" data-badge="${s}"></span></summary>
          ${c.cats.length > 8 ? `<input type="search" class="flt-search" placeholder="Buscar…" aria-label="Buscar en ${s}" data-search="${s}">` : ''}
          <div class="opts" data-opts="${s}">${c.cats.slice(0, 100).map(([v, n]) => `<label><input type="checkbox" data-cat="${s}" value="${esc(v)}"><span>${esc(v)}</span><small>${fmt(n)}</small></label>`).join('')}</div></details>`);
      } else if (c.type === 'date') {
        const iso = d => d.toISOString().slice(0, 10);
        h.push(`<fieldset class="flt"><legend>${s}</legend><div class="pair"><label>Desde<input type="date" data-from="${s}" min="${iso(c.stats.min)}" max="${iso(c.stats.max)}"></label><label>Hasta<input type="date" data-to="${s}" min="${iso(c.stats.min)}" max="${iso(c.stats.max)}"></label></div></fieldset>`);
      } else {
        h.push(`<fieldset class="flt"><legend>${s}</legend><div class="pair"><label>Mín.<input type="number" step="any" data-min="${s}" placeholder="${esc(fmt(c.stats.min))}"></label><label>Máx.<input type="number" step="any" data-max="${s}" placeholder="${esc(fmt(c.stats.max))}"></label></div></fieldset>`);
      }
    }
    this.els.filters.innerHTML = h.join('');
  }

  onFilter(e) {
    const t = e.target, d = t.dataset;
    if (d.search !== undefined) {
      const q = t.value.toLowerCase();
      this.els.filters.querySelectorAll(`[data-opts="${CSS.escape(d.search)}"] label`).forEach(l => { l.hidden = !l.textContent.toLowerCase().includes(q); });
      return;
    }
    if (d.cat !== undefined) { const s = this.f[d.cat].sel; t.checked ? s.add(t.value) : s.delete(t.value); }
    else if (d.from !== undefined) this.f[d.from].from = t.value ? new Date(t.value + 'T00:00') : null;
    else if (d.to !== undefined) this.f[d.to].to = t.value ? new Date(t.value + 'T23:59:59') : null;
    else if (d.min !== undefined) this.f[d.min].min = t.value === '' ? null : +t.value;
    else if (d.max !== undefined) this.f[d.max].max = t.value === '' ? null : +t.value;
    else return;
    this.page = 0;
    clearTimeout(this.tm); this.tm = setTimeout(() => this.update(), 120);
  }

  toggleCat(col, val) {
    const f = this.f[col]; if (!f || f.kind !== 'cat' || val === 'Otros') return;
    f.sel.has(val) ? f.sel.delete(val) : f.sel.add(val);
    this.els.filters.querySelectorAll(`[data-cat="${CSS.escape(col)}"]`).forEach(i => { i.checked = f.sel.has(i.value); });
    this.page = 0; this.update();
  }

  reset() {
    for (const k in this.f) { const f = this.f[k]; if (f.kind === 'cat') f.sel.clear(); else if (f.kind === 'date') f.from = f.to = null; else f.min = f.max = null; }
    this.els.filters.querySelectorAll('input').forEach(i => { if (i.type === 'checkbox') i.checked = false; else i.value = ''; });
    this.els.filters.querySelectorAll('label').forEach(l => { l.hidden = false; });
    this.page = 0; this.update();
  }

  rows() {
    const act = Object.entries(this.f).filter(([, f]) => (f.kind === 'cat' ? f.sel.size : f.kind === 'date' ? f.from || f.to : f.min != null || f.max != null));
    if (!act.length) return this.ds.rows;
    return this.ds.rows.filter(r => act.every(([c, f]) => {
      const v = r[c];
      if (f.kind === 'cat') return v != null && f.sel.has(String(v));
      if (v == null) return false;
      if (f.kind === 'date') return (!f.from || v >= f.from) && (!f.to || v <= f.to);
      return (f.min == null || v >= f.min) && (f.max == null || v <= f.max);
    }));
  }

  activeFilters() {
    const out = [];
    for (const [c, f] of Object.entries(this.f)) {
      if (f.kind === 'cat' && f.sel.size) out.push(`${c}: ${[...f.sel].join(', ')}`);
      else if (f.kind === 'date' && (f.from || f.to)) out.push(`${c}: ${f.from ? fmtDate(f.from) : '…'} → ${f.to ? fmtDate(f.to) : '…'}`);
      else if (f.kind === 'num' && (f.min != null || f.max != null)) out.push(`${c}: ${f.min ?? '…'} – ${f.max ?? '…'}`);
    }
    return out;
  }

  /* ---- render ---- */
  buildCards() {
    this.els.charts.innerHTML = this.spec.charts.filter(c => c.on).map((c, i) => `<figure class="card chart ${c.type === 'hist' || c.type === 'scatter' ? '' : ''}"><figcaption><strong>${esc(this.chartTitle(c))}</strong>${c.why ? `<span>${esc(c.why)}</span>` : ''}</figcaption><div class="plot" id="plot${i}" role="img" aria-label="${esc(this.chartTitle(c))}"></div></figure>`).join('');
    this.charts = this.spec.charts.filter(c => c.on).map((c, i) => {
      const inst = echarts.init(document.getElementById('plot' + i), null, { renderer: 'canvas' });
      inst.on('click', p => this.toggleCat(c.x, p.name));
      return { spec: c, inst };
    });
  }

  chartTitle(c) {
    if (c.type === 'hist') return `Distribución de ${c.x}`;
    if (c.type === 'scatter') return `${c.y} vs ${c.x}`;
    if (c.type === 'line') return `${aggLabel(c.y ? c.agg : 'count', c.y)} por ${c.x}`;
    return `${aggLabel(c.y ? c.agg : 'count', c.y)} por ${c.x}`;
  }

  update() {
    const rows = this.rows(), total = this.ds.nRows;
    const act = this.activeFilters();
    this.els.summary.innerHTML = `<strong>${fmt(rows.length)}</strong> de ${fmt(total)} filas${act.length ? ` · filtros: ${esc(act.join(' | '))}` : ' · sin filtros'}`;
    for (const k in this.f) {
      const b = this.els.filters.querySelector(`[data-badge="${CSS.escape(k)}"]`);
      if (b) b.textContent = this.f[k].sel?.size || '';
    }
    this.exports = [];
    this.els.kpis.innerHTML = this.spec.kpis.filter(k => k.on).map(k => {
      const v = aggregate(rows, k.col, k.agg);
      const base = act.length ? aggregate(this.ds.rows, k.col, k.agg) : null;
      this.exports.push({ name: 'KPI', head: [k.label, 'Valor'], rows: [[k.label, v]], kpi: true });
      return `<div class="kpi"><span>${esc(k.label)}</span><strong>${esc(fmt(v))}</strong>${base != null ? `<small>sin filtros: ${esc(fmt(base))}</small>` : ''}</div>`;
    }).join('');
    for (const { spec, inst } of this.charts) {
      const r = this.chartOption(spec, rows);
      if (r) { inst.setOption(r.option, true); }
      else inst.setOption({ title: { text: 'Sin datos con los filtros actuales', left: 'center', top: 'middle', textStyle: { color: css('--muted'), fontSize: 13, fontWeight: 400 } }, series: [], xAxis: { show: false }, yAxis: { show: false } }, true);
      if (r) this.exports.push({ name: this.chartTitle(spec), head: r.head, rows: r.table });
    }
    this.renderTables(rows);
  }

  chartOption(c, rows) {
    const text = css('--text'), muted = css('--muted'), line = css('--line'), color = ['#2a8f6a', '#e8590c', '#3a8fb0', '#d4a017', '#8a6d3b', '#5d6b63', '#7aa33a', '#b3261e'];
    const base = { color, textStyle: { fontFamily: 'Nunito, system-ui, sans-serif', color: text }, grid: { left: 4, right: 16, top: 16, bottom: 4, containLabel: true }, tooltip: { trigger: 'axis', valueFormatter: v => fmt(v), confine: true } };
    const ax = { axisLabel: { color: muted, hideOverlap: true }, axisLine: { lineStyle: { color: line } }, axisTick: { show: false }, splitLine: { lineStyle: { color: line } } };
    const val = { ...ax, type: 'value', axisLabel: { color: muted, formatter: v => fmt(v) }, axisLine: { show: false } };
    const yName = c.y ? aggLabel(c.agg, c.y) : 'Registros';
    const trim = s => (s.length > 18 ? s.slice(0, 17) + '…' : s);
    if (c.type === 'bar' || c.type === 'hbar') {
      const g = groupBy(rows, c.x, c.y, c.agg, c.type === 'hbar' ? 12 : 10); if (!g.length) return null;
      const cat = { ...ax, type: 'category', data: g.map(a => a[0]), axisLabel: { color: muted, interval: 0, formatter: trim, rotate: c.type === 'bar' && g.length > 6 ? 30 : 0 }, splitLine: { show: false }, inverse: c.type === 'hbar' };
      return { head: [c.x, yName], table: g, option: { ...base, xAxis: c.type === 'hbar' ? val : cat, yAxis: c.type === 'hbar' ? cat : val, series: [{ type: 'bar', data: g.map(a => a[1]), itemStyle: { color: color[0], borderRadius: c.type === 'hbar' ? [0, 6, 6, 0] : [6, 6, 0, 0] }, barMaxWidth: 28 }] } };
    }
    if (c.type === 'pie') {
      const g = groupBy(rows, c.x, null, 'count', 7); if (!g.length) return null;
      return { head: [c.x, 'Registros'], table: g, option: { ...base, tooltip: { trigger: 'item', valueFormatter: v => fmt(v) }, legend: { bottom: 0, textStyle: { color: muted }, formatter: trim, icon: 'rect', itemWidth: 10, itemHeight: 10 }, series: [{ type: 'pie', radius: ['42%', '68%'], center: ['50%', '44%'], data: g.map(([name, value]) => ({ name, value })), label: { color: text, formatter: '{d}%' }, itemStyle: { borderColor: css('--card'), borderWidth: 2 } }] } };
    }
    if (c.type === 'line') {
      const ts = timeSeries(rows, c.x, c.y, c.agg); if (!ts.length) return null;
      return { head: [c.x, yName], table: ts, option: { ...base, xAxis: { ...ax, type: 'category', data: ts.map(a => a[0]), splitLine: { show: false } }, yAxis: val, series: [{ type: 'line', data: ts.map(a => a[1]), symbol: ts.length > 40 ? 'none' : 'circle', symbolSize: 5, lineStyle: { width: 2 }, areaStyle: { opacity: .08 }, itemStyle: { color: color[0] } }] } };
    }
    if (c.type === 'hist') {
      const h = histogram(rows, c.x); if (!h) return null;
      return { head: [`Rango de ${c.x}`, 'Registros'], table: h.labels.map((l, i) => [l, h.counts[i]]), option: { ...base, xAxis: { ...ax, type: 'category', data: h.labels, splitLine: { show: false }, axisLabel: { color: muted, hideOverlap: true } }, yAxis: val, series: [{ type: 'bar', data: h.counts, barCategoryGap: '8%', itemStyle: { color: color[2], borderRadius: [4, 4, 0, 0] } }] } };
    }
    if (c.type === 'scatter') {
      const pts = []; const step = Math.max(1, Math.floor(rows.length / 3000));
      for (let i = 0; i < rows.length; i += step) { const a = rows[i][c.x], b = rows[i][c.y]; if (typeof a === 'number' && typeof b === 'number') pts.push([a, b]); }
      if (!pts.length) return null;
      return { head: [c.x, c.y], table: pts.slice(0, 500), option: { ...base, tooltip: { trigger: 'item', valueFormatter: v => fmt(v) }, xAxis: { ...val, name: c.x, nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: muted } }, yAxis: { ...val, name: c.y, nameTextStyle: { color: muted } }, series: [{ type: 'scatter', data: pts, symbolSize: 6, itemStyle: { color: color[0], opacity: .55 } }] } };
    }
    return null;
  }

  renderTables(rows) {
    const out = [];
    for (const t of this.spec.tables.filter(t => t.on)) {
      if (t.type === 'top') {
        const g = groupBy(rows, t.x, t.y, t.agg, 20), sum = g.reduce((s, a) => s + (a[1] || 0), 0);
        const head = [t.x, t.y ? aggLabel(t.agg, t.y) : 'Registros', '%'];
        this.exports.push({ name: `Ranking ${t.x}`, head, rows: g.map(a => [a[0], a[1], sum ? a[1] / sum : null]) });
        out.push(this.tbl(`Ranking por ${t.x}`, head, g.map(a => [a[0], fmt(a[1]), sum ? (a[1] / sum * 100).toFixed(1) + '%' : '—']), [1, 2]));
      } else if (t.type === 'stats') {
        const nc = this.ds.cols.filter(c => c.type === 'number');
        const data = nc.map(c => { const v = rows.map(r => r[c.name]).filter(x => typeof x === 'number').sort((a, b) => a - b); return [c.name, v.length, aggregate(rows, c.name, 'sum'), aggregate(rows, c.name, 'avg'), v[0], aggregate(rows, c.name, 'median'), v[v.length - 1]]; });
        const head = ['Variable', 'N', 'Suma', 'Promedio', 'Mín.', 'Mediana', 'Máx.'];
        this.exports.push({ name: 'Estadísticas', head, rows: data });
        out.push(this.tbl('Estadísticas descriptivas', head, data.map(r => r.map((v, i) => (i ? fmt(v) : v))), [1, 2, 3, 4, 5, 6]));
      } else if (t.type === 'data') {
        let rs = rows;
        if (this.sort) { const { col, dir } = this.sort; rs = rows.slice().sort((a, b) => { const x = a[col], y = b[col]; return (x == null) - (y == null) || (x > y ? 1 : x < y ? -1 : 0) * dir; }); }
        const pages = Math.max(1, Math.ceil(rs.length / PAGE)); this.page = Math.min(this.page, pages - 1);
        const cols = this.ds.cols.map(c => c.name);
        const body = rs.slice(this.page * PAGE, (this.page + 1) * PAGE).map(r => cols.map(c => (r[c] instanceof Date ? fmtDate(r[c]) : r[c] == null ? '' : typeof r[c] === 'number' ? fmt(r[c]) : r[c])));
        out.push(this.tbl('Datos', cols, body, this.ds.cols.map((c, i) => (c.type === 'number' ? i : -1)).filter(i => i >= 0), true, `<div class="pager no-print"><button type="button" data-page="-1" ${this.page === 0 ? 'disabled' : ''}>Anterior</button><span>Página ${this.page + 1} de ${pages}</span><button type="button" data-page="1" ${this.page >= pages - 1 ? 'disabled' : ''}>Siguiente</button></div>`));
      }
    }
    this.els.tables.innerHTML = out.join('');
  }

  tbl(title, head, body, numCols, sortable, extra = '') {
    const th = head.map((h, i) => `<th${numCols.includes(i) ? ' class="n"' : ''} ${sortable ? `data-sort="${esc(h)}" tabindex="0" aria-sort="${this.sort?.col === h ? (this.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"` : ''}>${esc(h)}</th>`).join('');
    const tr = body.map(r => `<tr>${r.map((v, i) => `<td${numCols.includes(i) ? ' class="n"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('');
    return `<section class="card tbl"><h3>${esc(title)}</h3><div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>${extra}</section>`;
  }

  onTable(e) {
    const p = e.target.closest('[data-page]'), s = e.target.closest('[data-sort]');
    if (p) { this.page += +p.dataset.page; this.renderTables(this.rows()); }
    if (s) { const col = s.dataset.sort; this.sort = this.sort?.col === col ? { col, dir: -this.sort.dir } : { col, dir: 1 }; this.page = 0; this.renderTables(this.rows()); }
  }

  resize() { this.charts.forEach(c => c.inst.resize()); }
  dispose() { this.charts.forEach(c => c.inst.dispose()); }

  /* ---- exportar ---- */
  exportExcel(fileName) {
    const wb = XLSX.utils.book_new();
    const act = this.activeFilters();
    const kp = this.exports.filter(e => e.kpi);
    const resumen = [['Reporte', this.ds.name], ['Filas incluidas', this.rows().length], ['Filas totales', this.ds.nRows], ['Filtros', act.join(' | ') || 'ninguno'], [], ['Indicador', 'Valor'], ...kp.map(k => k.rows[0])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');
    const used = new Set(['Resumen']);
    for (const e of this.exports.filter(e => !e.kpi)) {
      let n = e.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28), k = 2; const b = n;
      while (used.has(n)) n = `${b} ${k++}`;
      used.add(n);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([e.head, ...e.rows]), n);
    }
    const cols = this.ds.cols.map(c => c.name);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols, ...this.rows().slice(0, 1000000).map(r => cols.map(c => r[c]))], { cellDates: true }), 'Datos filtrados');
    XLSX.writeFile(wb, fileName);
  }
}

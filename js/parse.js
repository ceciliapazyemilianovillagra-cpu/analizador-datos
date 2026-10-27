// Lee xlsx/xls/ods/csv/tsv/json y devuelve una lista de tablas crudas {name, headers, rows}.
export async function readFile(file) {
  const buf = await file.arrayBuffer();
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') throw new Error('Los PDF no están soportados. Usá Excel, CSV u otra planilla.');
  let sheets = [];
  if (ext === 'json') {
    let data = JSON.parse(new TextDecoder().decode(buf));
    if (!Array.isArray(data)) data = Object.values(data).find(Array.isArray) || [data];
    const headers = [...new Set(data.flatMap(o => Object.keys(o)))];
    sheets.push({ name: file.name, aoa: [headers, ...data.map(o => headers.map(h => o[h] ?? null))] });
  } else {
    let wb;
    if (['csv', 'tsv', 'txt'].includes(ext)) {
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
      const first = text.split(/\r?\n/, 1)[0];
      const FS = [';', '\t', ',', '|'].map(s => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
      // Lector propio: SheetJS convierte "5,3" en 53 al leer CSV.
      sheets = [{ name: file.name, aoa: parseDelimited(text, FS) }];
    } else {
      wb = XLSX.read(buf, { type: 'array', cellDates: true });
      sheets = wb.SheetNames.map(n => ({
        name: n,
        aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: false }),
      }));
    }
  }
  return sheets.map(toTable).filter(Boolean);
}

function parseDelimited(text, sep) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const empty = v => v == null || (typeof v === 'string' && v.trim() === '');

function toTable({ name, aoa }) {
  aoa = aoa.filter(r => r.some(v => !empty(v)));
  if (aoa.length < 2) return null;
  const counts = aoa.slice(0, 10).map(r => r.filter(v => !empty(v)).length);
  const maxC = Math.max(...counts);
  const h = counts.findIndex(c => c >= maxC * 0.7);
  const used = new Set();
  const keep = [], headers = [];
  aoa[h].forEach((v, j) => {
    const hasData = aoa.slice(h + 1).some(r => !empty(r[j]));
    if (empty(v) && !hasData) return;
    let t = empty(v) ? `Columna ${j + 1}` : String(v).trim();
    for (let k = 2; used.has(t); k++) t = `${String(v).trim()} (${k})`;
    used.add(t); keep.push(j); headers.push(t);
  });
  const rows = aoa.slice(h + 1).map(r => keep.map(j => (typeof r[j] === 'string' ? (r[j].trim() || null) : r[j] ?? null)));
  return { name, headers, rows };
}

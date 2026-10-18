// File readers with no dependencies: CSV, and .xlsx (a zip of XML files) via node:zlib.
import { inflateRawSync } from 'node:zlib';
import { AppError } from '../errors.js';

// ---------- CSV ----------
export function parseCsv(input) {
  let s = String(input).replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => (first.match(new RegExp(ch === '\t' ? '\t' : '\\' + ch, 'g')) || []).length;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

// ---------- XLSX ----------
const MAX_UNZIPPED = 60 * 1024 * 1024;
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new AppError(422, 'BAD_XLSX', 'This is not a valid .xlsx file');
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const files = new Map(); let total = 0;
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new AppError(422, 'BAD_XLSX', 'Damaged .xlsx file');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + el + cl;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    total += usize; if (total > MAX_UNZIPPED) throw new AppError(413, 'TOO_LARGE', 'The spreadsheet is too large');
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), raw = buf.subarray(ds, ds + csize);
    files.set(name, method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED }));
  }
  return files;
}
const ent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
});
const textOf = (xml) => [...xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => ent(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export function parseXlsx(buf, sheetName = null) {
  const f = unzip(buf), get = (n) => f.get(n)?.toString('utf8');
  const wb = get('xl/workbook.xml'); if (!wb) throw new AppError(422, 'BAD_XLSX', 'No workbook found in this file');
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: ent(/name="([^"]*)"/.exec(m[0])?.[1] || ''), rid: /r:id="([^"]*)"/.exec(m[0])?.[1] }));
  const chosen = (sheetName && sheets.find((s) => s.name === sheetName)) || sheets[0];
  if (!chosen) throw new AppError(422, 'BAD_XLSX', 'The workbook has no sheets');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => new RegExp(`Id="${chosen.rid}"`).test(r));
  let target = /Target="([^"]*)"/.exec(rel || '')?.[1] || 'worksheets/sheet1.xml';
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  const sheet = get(target); if (!sheet) throw new AppError(422, 'BAD_XLSX', 'Could not read the first sheet');
  const sst = get('xl/sharedStrings.xml'), strings = sst ? [...sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = []; const rn = /\br="(\d+)"/.exec(rm[0])?.[1];
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (cm[1] !== undefined) continue;                                           // empty cell
      const attrs = cm[2], body = cm[3], ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1], type = /\bt="([^"]*)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (type === 's') val = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') val = textOf(body);
      else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = ent(v);
      if (ref) cells[colIndex(ref)] = val;
    }
    rows.push({ n: Number(rn) || rows.length + 1, cells: Array.from(cells, (x) => x ?? '') });
  }
  return rows.filter((r) => r.cells.some((x) => String(x).trim() !== ''));
}

/** Read an uploaded file (Buffer + name) into { headers, rows, startRow }. */
export function readTable(buffer, filename = '', { sheet } = {}) {
  const isXlsx = /\.xlsx$/i.test(filename) || (buffer[0] === 0x50 && buffer[1] === 0x4b);
  if (/\.xls$/i.test(filename)) throw new AppError(422, 'OLD_XLS', 'Old .xls files are not supported. In Excel choose Save As > .xlsx or CSV.');
  let all;
  if (isXlsx) { const r = parseXlsx(buffer, sheet); all = r.map((x) => ({ n: x.n, cells: x.cells })); }
  else all = parseCsv(buffer.toString('utf8')).map((cells, i) => ({ n: i + 1, cells }));
  if (all.length < 2) throw new AppError(422, 'EMPTY_FILE', 'The file needs a header row and at least one data row');
  const width = Math.max(...all.map((r) => r.cells.length));
  const pad = (c) => Array.from({ length: width }, (_, i) => String(c[i] ?? '').trim());
  return { headers: pad(all[0].cells), rows: all.slice(1).map((r) => ({ n: r.n, cells: pad(r.cells) })) };
}

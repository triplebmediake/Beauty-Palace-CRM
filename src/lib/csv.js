// CSV with a UTF-8 BOM (so Excel opens it correctly). Text cells that start with = + - @ are prefixed with ' so a
// customer named "=HYPERLINK(...)" cannot run as a formula when the file is opened in Excel.
const cell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (headers, rows) => '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');

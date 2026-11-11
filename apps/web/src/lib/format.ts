export const fmtDate = (d?: string | Date | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const fmtDateTime = (d?: string | Date | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

export function relTime(d?: string | Date | null) {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  const abs = Math.abs(s);
  const unit = abs < 60 ? 'just now' : abs < 3600 ? `${Math.floor(abs / 60)}m` : abs < 86400 ? `${Math.floor(abs / 3600)}h` : abs < 86400 * 30 ? `${Math.floor(abs / 86400)}d` : null;
  if (unit === null) return fmtDate(d);
  if (unit === 'just now') return unit;
  return s >= 0 ? `${unit} ago` : `in ${unit}`;
}

export function money(n: number | null | undefined, currency = 'INR') {
  if (n === null || n === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString('en-IN')}`;
  }
}

/** Value for <input type="datetime-local"> in the user's local time. */
export function toLocalInput(d?: string | Date | null) {
  if (!d) return '';
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Displays a stored custom-field value as text. */
export function fmtCustom(type: string, v: unknown): string {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '';
  if (type === 'CHECKBOX') return v ? 'Yes' : 'No';
  if (type === 'DATE') return fmtDate(String(v));
  if (type === 'NUMBER') return Number(v).toLocaleString('en-IN');
  if (type === 'URL') return String(v).replace(/^https?:\/\//, '');
  return Array.isArray(v) ? v.join(', ') : String(v);
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

export const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF, and a UTF-8 byte-order mark. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

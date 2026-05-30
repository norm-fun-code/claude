// Minimal, dependency-free CSV parser (RFC 4180-ish). Handles quoted fields,
// embedded commas/newlines, and escaped ("") quotes — enough for bank/finance
// exports like Monarch. Pure and unit-tested.

/** Parse CSV text into an array of string-cell rows. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text ?? '').replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  // Flush trailing field/row if the file didn't end on a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV into row objects keyed by header. Headers are taken from the first
 * non-empty row and trimmed. Blank lines are skipped.
 */
function parseCsvObjects(text) {
  const rows = parseCsv(text).filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (r[i] ?? '').trim();
    });
    return obj;
  });
  return { headers, records };
}

module.exports = { parseCsv, parseCsvObjects };

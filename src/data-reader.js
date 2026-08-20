import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { asNumber, columnIndex, xmlUnescape } from './utils.js';

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    return swapped.toString('utf16le');
  }
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return new TextDecoder('gb18030').decode(buffer); }
  catch { return utf8; }
}

function parseCsvText(text, delimiter = null) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = delimiter ?? ([',', '\t', ';', '|'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]);
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === sep && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell.length || row.length) { row.push(cell); if (row.some(v => v.trim() !== '')) rows.push(row); }
  if (!rows.length) return { columns: [], rows: [] };
  const columns = rows[0].map((value, i) => value.trim() || `column_${i + 1}`);
  return { columns, rows: rows.slice(1).map(values => Object.fromEntries(columns.map((column, i) => [column, values[i]?.trim() ?? ''])))};
}

function zipEntries(buffer) {
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let end = buffer.lastIndexOf(eocd);
  if (end < 0) throw new Error('Invalid XLSX ZIP container');
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid XLSX central directory');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const value = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (!value) throw new Error(`Unsupported XLSX compression method: ${method}`);
    entries.set(name, value);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match =>
    [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => xmlUnescape(m[1])).join('')
  );
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const values = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1];
      const index = ref ? columnIndex(ref) : values.length;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
      let value = xmlUnescape(raw);
      if (type === 's') value = sharedStrings[Number(value)] ?? value;
      else if (type !== 'str' && /^-?\d+(\.\d+)?$/.test(value)) value = asNumber(value);
      values[index] = value;
    }
    rows.push(values);
  }
  const candidates = rows.slice(0, Math.min(20, rows.length));
  let headerIndex = 0;
  let bestScore = -Infinity;
  candidates.forEach((values, index) => {
    const nonEmpty = values.filter(value => value !== '' && value !== null && value !== undefined);
    const textCount = nonEmpty.filter(value => typeof value === 'string' && asNumber(value) === null).length;
    const numericCount = nonEmpty.length - textCount;
    const score = nonEmpty.length * 2 + textCount * 3 - numericCount * 2;
    if (score > bestScore) { bestScore = score; headerIndex = index; }
  });
  const seen = new Map();
  const header = (rows[headerIndex] ?? []).map((value, i) => {
    const base = String(value ?? '').trim() || `column_${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
  const dataRows = rows.slice(headerIndex + 1)
    .filter(values => values.some(value => value !== '' && value !== null && value !== undefined))
    .map(values => Object.fromEntries(header.map((column, i) => [column, values[i] ?? ''])))
    .filter(row => {
      const firstText = header.map(column => row[column]).find(value => typeof value === 'string' && value.trim());
      return !/^(合计|总计|小计|汇总|total|subtotal)$/i.test(String(firstText ?? '').trim());
    });
  return { columns: header, rows: dataRows };
}

function parseXlsx(buffer) {
  const entries = zipEntries(buffer);
  const sharedStrings = entries.has('xl/sharedStrings.xml') ? parseSharedStrings(entries.get('xl/sharedStrings.xml').toString()) : [];
  const workbook = entries.get('xl/workbook.xml')?.toString() ?? '';
  const relationships = entries.get('xl/_rels/workbook.xml.rels')?.toString() ?? '';
  const rels = new Map([...relationships.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2].replace(/^\//, '')]));
  const sheets = [...workbook.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(m => ({ name: xmlUnescape(m[1]), target: rels.get(m[2]) }));
  const result = new Map();
  for (const sheet of sheets) {
    const target = sheet.target?.startsWith('xl/') ? sheet.target : `xl/${sheet.target}`;
    const xml = entries.get(target);
    if (xml) result.set(sheet.name, parseSheet(xml.toString(), sharedStrings));
  }
  return result;
}

export async function readDataFile(file) {
  const stat = await fs.stat(file);
  const maxBytes = Number(process.env.MAX_FILE_BYTES || 524288000);
  if (stat.size > maxBytes) throw new Error(`File exceeds MAX_FILE_BYTES (${maxBytes})`);
  const ext = path.extname(file).toLowerCase();
  const buffer = await fs.readFile(file);
  if (ext === '.csv' || ext === '.tsv') {
    const text = decodeText(buffer).replace(/^\uFEFF/, '');
    return new Map([['default', parseCsvText(text, ext === '.tsv' ? '\t' : null)]]);
  }
  if (ext === '.xlsb') {
    try {
      const xlsx = await import('xlsx');
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      return new Map(workbook.SheetNames.map(name => {
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
        const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
        return [name, { columns, rows: rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? '']))) }];
      }));
    } catch {
      throw new Error('XLSB 需要可选依赖 xlsx。请运行 npm.cmd install xlsx，或先另存为 XLSX/CSV。');
    }
  }
  if (['.xlsx', '.xlsm'].includes(ext)) return parseXlsx(buffer);
  throw new Error(`Unsupported data file: ${ext}`);
}

export async function discoverDataFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(csv|tsv|xlsx|xlsm|xlsb)$/i.test(entry.name)) files.push(full);
    }
  }
  await walk(root);
  return files;
}

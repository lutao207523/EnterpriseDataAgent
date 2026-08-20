import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalized = String(value).replace(/[,%￥$€£\s]/g, '').replace(/，/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_\-（）()]/g, '');
}

export function xmlUnescape(value) {
  return String(value)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function columnName(index) {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

export function columnIndex(name) {
  let result = 0;
  for (const char of name.toUpperCase()) result = result * 26 + char.charCodeAt(0) - 64;
  return result - 1;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}

export function parseArgs(argv) {
  const files = [];
  const questionParts = [];
  let output = path.join(process.cwd(), 'output');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output') output = path.resolve(argv[++i]);
    else if (argv[i].startsWith('--')) continue;
    else if (files.length === 0 && /\.(csv|tsv|xlsx|xlsm|xlsb)$/i.test(argv[i])) files.push(path.resolve(argv[i]));
    else questionParts.push(argv[i]);
  }
  return { files, question: questionParts.join(' ').trim(), output };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, ensureDir } from './utils.js';

const SETTINGS_FILE = path.join(ROOT, 'config', 'settings.json');

export async function getModelSettings() {
  let stored = {};
  try { stored = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')); } catch { /* first run */ }
  return {
    baseUrl: stored.baseUrl || process.env.PI_BASE_URL || 'https://api.openai.com/v1',
    model: stored.model || process.env.PI_MODEL || '',
    apiKey: stored.apiKey || process.env.PI_API_KEY || '',
  };
}

export async function getPublicModelSettings() {
  const settings = await getModelSettings();
  return { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.model && (settings.apiKey || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.baseUrl))) };
}

export async function saveModelSettings(input) {
  const previous = await getModelSettings();
  const settings = {
    baseUrl: String(input.baseUrl || previous.baseUrl || '').trim().replace(/\/$/, ''),
    model: String(input.model || '').trim(),
    apiKey: String(input.apiKey || previous.apiKey || '').trim(),
  };
  if (!/^https?:\/\//i.test(settings.baseUrl)) throw new Error('模型 API 地址必须以 http:// 或 https:// 开头。');
  await ensureDir(path.dirname(SETTINGS_FILE));
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  return { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.model && (settings.apiKey || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.baseUrl))) };
}

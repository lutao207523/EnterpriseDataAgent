import fs from 'node:fs/promises';
import path from 'node:path';
import { renderChartSvg } from './chart-renderer.js';
import { ensureDir, writeJson } from './utils.js';

export function isChartRequest(question) {
  return /(生成|制作|创建|做|画|绘制|转成|变成).{0,8}(图片|图|图表|柱状图|折线图|饼图|趋势图)|(?:柱状图|折线图|饼图|趋势图|可视化)/i.test(String(question || ''));
}

export function isConversationChartFollowUp(question) {
  const text = String(question || '').replace(/\s/g, '');
  return isChartRequest(text) && (text.length <= 8 || /(上面|上述|刚才|前面|这些数据|这个结果|根据.*数据)/.test(text));
}

function parseNumber(value) {
  const text = String(value ?? '').trim().replace(/[,，\s￥¥$]/g, '');
  const match = text.match(/^(-?\d+(?:\.\d+)?)(万|亿|%|％)?/);
  if (!match) return null;
  let number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  if (match[2] === '万') number *= 10_000;
  if (match[2] === '亿') number *= 100_000_000;
  return number;
}

function rowCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function chartType(question) {
  const text = String(question || '');
  if (/饼图|占比|比例/.test(text)) return 'pie';
  if (/折线图|趋势图|趋势/.test(text)) return 'line';
  return 'bar';
}

export function extractConversationChartSpec({ question, history = [] }) {
  for (const message of [...history].reverse()) {
    const lines = String(message.content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let index = 0; index < lines.length - 2; index += 1) {
      if (!lines[index].includes('|')) continue;
      const headers = rowCells(lines[index]);
      const separator = rowCells(lines[index + 1]);
      if (headers.length < 2 || separator.length !== headers.length || !isSeparatorRow(separator)) continue;
      const tableRows = [];
      for (let rowIndex = index + 2; rowIndex < lines.length && lines[rowIndex].includes('|'); rowIndex += 1) {
        const cells = rowCells(lines[rowIndex]);
        if (cells.length === headers.length && !isSeparatorRow(cells)) tableRows.push(cells);
      }
      if (!tableRows.length) continue;
      const numericCounts = headers.map((_, column) => tableRows.filter(row => parseNumber(row[column]) !== null).length);
      const numericColumns = numericCounts.map((count, column) => ({ count, column })).filter(item => item.count >= Math.max(1, Math.ceil(tableRows.length * 0.6)));
      if (!numericColumns.length) continue;
      const requestedMetric = numericColumns.find(item => String(question).includes(headers[item.column]));
      const valueIndex = (requestedMetric ?? numericColumns[0]).column;
      const labelIndex = headers.findIndex((_, column) => column !== valueIndex && numericCounts[column] < Math.ceil(tableRows.length * 0.5));
      if (labelIndex < 0) continue;
      const data = tableRows.map(row => ({ label: row[labelIndex], value: parseNumber(row[valueIndex]) })).filter(row => row.label && row.value !== null).slice(0, 20);
      if (!data.length) continue;
      return {
        type: chartType(question),
        title: `${headers[valueIndex]}按${headers[labelIndex]}`,
        labelKey: 'label',
        valueKey: 'value',
        labelName: headers[labelIndex],
        valueName: headers[valueIndex],
        data,
      };
    }
  }
  return null;
}

async function extractWithModel({ question, history, settings }) {
  if (!settings?.model || !settings?.apiKey) return null;
  const transcript = history.slice(-10).map(item => `${item.role === 'user' ? '用户' : '助手'}：${item.content}`).join('\n\n');
  const prompt = `从下面对话中提取用户想可视化的数据，只能使用对话里明确出现的数字，不得编造。\n返回严格 JSON，不要 Markdown：\n{"title":"标题","type":"bar|line|pie","labelName":"分类字段","valueName":"数值字段","items":[{"label":"分类","value":123}]}\n如果没有至少两项可绘图数据，返回 {"items":[]}。\n\n当前要求：${question}\n\n对话：\n${transcript}`;
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], temperature: 0, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `图表数据提取失败：HTTP ${response.status}`);
  const content = String(body.choices?.[0]?.message?.content || '');
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  const data = (parsed.items ?? []).map(item => ({ label: String(item.label || '').trim(), value: Number(item.value) })).filter(item => item.label && Number.isFinite(item.value)).slice(0, 20);
  if (data.length < 2) return null;
  return {
    type: ['bar', 'line', 'pie'].includes(parsed.type) ? parsed.type : chartType(question),
    title: String(parsed.title || '对话数据图表'),
    labelKey: 'label', valueKey: 'value',
    labelName: String(parsed.labelName || '分类'), valueName: String(parsed.valueName || '数值'),
    data,
  };
}

export async function generateConversationChart({ question, history = [], settings, outputDir }) {
  const spec = extractConversationChartSpec({ question, history }) ?? await extractWithModel({ question, history, settings });
  if (!spec) return null;
  await ensureDir(outputDir);
  await fs.writeFile(path.join(outputDir, 'chart.svg'), renderChartSvg(spec), 'utf8');
  await writeJson(path.join(outputDir, 'chart.json'), spec);
  const typeName = spec.type === 'pie' ? '饼图' : spec.type === 'line' ? '折线图' : '柱状图';
  return {
    summary: `已根据当前对话中的“${spec.labelName}”和“${spec.valueName}”生成${typeName}。`,
    spec,
    rows: spec.data.map(item => ({ [spec.labelName]: item.label, [spec.valueName]: item.value })),
  };
}

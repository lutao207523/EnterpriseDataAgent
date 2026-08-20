import { escapeHtml } from './utils.js';

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value));
}

function normalizedData(spec, limit = 20) {
  return (spec?.data ?? []).slice(0, limit).filter(row => Number.isFinite(Number(row[spec.valueKey])));
}

function renderAxes(spec, data) {
  const width = 960, height = 480, left = 85, top = 55, bottom = 115;
  const usableWidth = width - left - 35, usableHeight = height - top - bottom;
  const values = data.map(row => Number(row[spec.valueKey]));
  const max = Math.max(...values, 1);
  const step = usableWidth / Math.max(data.length, 1);
  const common = { width, height, left, top, usableWidth, usableHeight, max, step };
  return common;
}

function renderBar(spec, data) {
  const { left, top, usableWidth, usableHeight, max, step } = renderAxes(spec, data);
  const colors = ['#2457d6', '#16845b', '#d97706', '#b42358', '#6d4bc3'];
  const bars = data.map((row, index) => {
    const value = Number(row[spec.valueKey]);
    const barHeight = Math.max(1, (value / max) * usableHeight);
    const x = left + index * step + step * 0.16;
    const y = top + usableHeight - barHeight;
    const label = escapeHtml(String(row[spec.labelKey]));
    return `<g><rect x="${x}" y="${y}" width="${step * 0.68}" height="${barHeight}" rx="2" fill="${colors[index % colors.length]}"/><text x="${x + step * 0.34}" y="${Math.max(42, y - 7)}" text-anchor="middle" font-size="11">${escapeHtml(formatNumber(value))}</text><text transform="translate(${x + step * 0.34},${top + usableHeight + 15}) rotate(42)" text-anchor="start" font-size="11">${label}</text></g>`;
  }).join('');
  return `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + usableHeight}" stroke="#58616a"/><line x1="${left}" y1="${top + usableHeight}" x2="${left + usableWidth}" y2="${top + usableHeight}" stroke="#58616a"/>${bars}`;
}

function renderLine(spec, data) {
  const { left, top, usableWidth, usableHeight, max, step } = renderAxes(spec, data);
  const points = data.map((row, index) => {
    const x = left + step * index + step / 2;
    const y = top + usableHeight - (Number(row[spec.valueKey]) / max) * usableHeight;
    return { x, y, row };
  });
  const labels = points.map(({ x, y, row }) => `<g><circle cx="${x}" cy="${y}" r="4" fill="#2457d6"/><text x="${x}" y="${Math.max(42, y - 10)}" text-anchor="middle" font-size="11">${escapeHtml(formatNumber(row[spec.valueKey]))}</text><text transform="translate(${x},${top + usableHeight + 15}) rotate(42)" text-anchor="start" font-size="11">${escapeHtml(String(row[spec.labelKey]))}</text></g>`).join('');
  return `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + usableHeight}" stroke="#58616a"/><line x1="${left}" y1="${top + usableHeight}" x2="${left + usableWidth}" y2="${top + usableHeight}" stroke="#58616a"/><polyline points="${points.map(point => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="#2457d6" stroke-width="3" stroke-linejoin="round"/>${labels}`;
}

function renderPie(spec, sourceData) {
  const data = sourceData.slice(0, 10).map(row => ({ ...row, __value: Math.max(0, Number(row[spec.valueKey])) })).filter(row => row.__value > 0);
  if (!data.length) return renderBar(spec, sourceData);
  const colors = ['#2457d6', '#16845b', '#d97706', '#b42358', '#6d4bc3', '#0f8296', '#c2410c', '#4d7c0f', '#be185d', '#475569'];
  const total = data.reduce((sum, row) => sum + row.__value, 0);
  const cx = 330, cy = 260, radius = 155;
  let angle = -Math.PI / 2;
  const slices = data.map((row, index) => {
    const next = angle + (row.__value / total) * Math.PI * 2;
    const x1 = cx + radius * Math.cos(angle), y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(next), y2 = cy + radius * Math.sin(next);
    const largeArc = next - angle > Math.PI ? 1 : 0;
    const path = `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${colors[index]}" stroke="white" stroke-width="2"/>`;
    angle = next;
    return path;
  }).join('');
  const legend = data.map((row, index) => `<g transform="translate(570 ${105 + index * 31})"><rect width="14" height="14" rx="2" fill="${colors[index]}"/><text x="23" y="12" font-size="12">${escapeHtml(String(row[spec.labelKey]))}：${escapeHtml(formatNumber(row.__value))}</text></g>`).join('');
  return `${slices}${legend}`;
}

export function renderChartSvg(spec) {
  const data = normalizedData(spec);
  if (!data.length) return '';
  const type = ['bar', 'line', 'pie'].includes(spec.type) ? spec.type : 'bar';
  const body = type === 'pie' ? renderPie(spec, data) : type === 'line' ? renderLine(spec, data) : renderBar(spec, data);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 480" width="960" height="480"><rect width="100%" height="100%" fill="white"/><text x="480" y="30" text-anchor="middle" font-size="20" font-family="Segoe UI, Microsoft YaHei, sans-serif" fill="#202124">${escapeHtml(spec.title)}</text><g font-family="Segoe UI, Microsoft YaHei, sans-serif" fill="#343a3f">${body}</g></svg>`;
}

export function renderMermaidChart(spec) {
  const data = normalizedData(spec);
  if (!data.length) return '';
  if (spec.type === 'pie') {
    return `pie title ${spec.title.replace(/"/g, '')}\n${data.slice(0, 10).map(row => `  "${String(row[spec.labelKey]).replace(/"/g, '')}" : ${Number(row[spec.valueKey]).toFixed(2)}`).join('\n')}`;
  }
  const labels = data.map(row => `"${String(row[spec.labelKey]).replace(/"/g, '')}"`).join(', ');
  const values = data.map(row => Number(row[spec.valueKey]).toFixed(2)).join(', ');
  return `xychart-beta\n  title "${spec.title.replace(/"/g, '')}"\n  x-axis [${labels}]\n  y-axis "${spec.valueKey}" 0 --> ${Math.ceil(Math.max(...data.map(row => Number(row[spec.valueKey])), 1))}\n  ${spec.type === 'line' ? 'line' : 'bar'} [${values}]`;
}

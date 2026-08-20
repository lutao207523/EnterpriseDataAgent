import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, escapeHtml, writeJson } from './utils.js';
import { renderChartSvg, renderMermaidChart } from './chart-renderer.js';

function formatNumber(value) {
  return typeof value === 'number' ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : String(value ?? '');
}

function chartSpec(rows, plan) {
  if (!rows.length || plan.responseMode === 'entity' || !plan.presentation?.chart) return null;
  const labelKey = plan.dimensions[0] ?? Object.keys(rows[0])[0];
  const valueKey = plan.metrics[0].field;
  const data = rows.slice(0, 20).filter(row => Number.isFinite(Number(row[valueKey])));
  return { type: plan.operation === 'trend' ? 'line' : 'bar', title: `${valueKey}按${labelKey}`, labelKey, valueKey, data };
}

function buildSummary(rows, plan) {
  if (!rows.length) return '没有可用于回答该问题的数据。';
  const metric = plan.metrics[0].field;
  const dimension = plan.dimensions[0] ?? '范围';
  const metricLabel = metric.replace(/[（(][^）)]*[）)]/gu, '');
  if (plan.responseMode === 'total') return `${metricLabel}总计为 ${formatNumber(rows[0][metric])}。`;
  if (plan.responseMode === 'comprehensive') {
    const highest = [...rows].sort((a, b) => Number(b[metric]) - Number(a[metric]))[0];
    const lowest = [...rows].sort((a, b) => Number(a[metric]) - Number(b[metric]))[0];
    const total = rows.reduce((sum, row) => sum + (Number(row[metric]) || 0), 0);
    const quantityMetric = plan.metrics.find(item => /(销量|销售量|数量|件数|订单)/i.test(item.field));
    const quantityBest = quantityMetric ? [...rows].sort((a, b) => Number(b[quantityMetric.field]) - Number(a[quantityMetric.field]))[0] : null;
    const entity = plan.dimensions[0] ?? '分组';
    const lines = [`综合分析完成：${metricLabel}总计为 ${formatNumber(total)}。`, `${metricLabel}最高的${entity}是“${highest[entity]}”，${metricLabel}为 ${formatNumber(highest[metric])}。`, `${metricLabel}最低的${entity}是“${lowest[entity]}”，${metricLabel}为 ${formatNumber(lowest[metric])}。`];
    if (quantityBest) lines.push(`销量最高的${entity}是“${quantityBest[entity]}”，销量为 ${formatNumber(quantityBest[quantityMetric.field])}。`);
    return lines.join(' ');
  }
  const ascending = plan.order === 'asc';
  const best = [...rows].sort((a, b) => ascending ? Number(a[metric]) - Number(b[metric]) : Number(b[metric]) - Number(a[metric]))[0];
  const rankWord = ascending ? '最低' : '最高';
  if (plan.responseMode === 'entity') {
    const nameDimension = plan.dimensions.find(item => /名称|name/i.test(item)) ?? plan.dimensions[0] ?? '结果';
    const entityLabel = nameDimension.replace(/名称$/u, '') || '商品';
    return `${metricLabel}${rankWord}的${entityLabel}是“${best[nameDimension]}”。`;
  }
  const additional = plan.metrics.slice(1).map(item => `${item.field} ${formatNumber(best[item.field])}`).join('，');
  const identity = (plan.dimensions.length ? plan.dimensions : [dimension]).map(item => `${item}“${best[item]}”`).join('、');
  return `${identity}的${metric}${rankWord}，为 ${formatNumber(best[metric])}${additional ? `，同时${additional}` : ''}。本次结果共包含 ${rows.length} 个分组。`;
}

export async function writeReport({ outputDir, question, source, sheet, profile, plan, rows }) {
  await ensureDir(outputDir);
  const chart = chartSpec(rows, plan);
  const mermaid = renderMermaidChart(chart);
  const summary = buildSummary(rows, plan);
  const report = {
    question, summary, generatedAt: new Date().toISOString(),
    dataSources: [{ path: source, sheet }],
    fieldMappings: plan.fieldMappings ?? [], assumptions: plan.assumptions ?? [],
    profile, plan, resultTables: [{ title: '分析结果', rows }],
    charts: chart ? [{ type: chart.type, title: chart.title, svg: 'chart.svg', mermaid: 'chart.mmd' }] : [],
    warnings: [],
    provenance: [{ operation: plan.operation, dimensions: plan.dimensions, metrics: plan.metrics }],
  };
  await writeJson(path.join(outputDir, 'report.json'), report);
  if (chart) {
    await fs.writeFile(path.join(outputDir, 'chart.svg'), renderChartSvg(chart), 'utf8');
    await fs.writeFile(path.join(outputDir, 'chart.mmd'), mermaid, 'utf8');
  }
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const table = rows.length ? `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${headers.map(h => formatNumber(row[h])).join(' | ')} |`).join('\n')}` : '无结果';
  const markdown = `# 企业报表分析报告\n\n## 问题\n\n${question}\n\n## 结论\n\n${summary}\n\n## 字段与口径\n\n- 数据源：${source}\n- Sheet：${sheet}\n- 维度：${plan.dimensions.join('、') || '无'}\n- 指标：${plan.metrics.map(m => `${m.field} (${m.aggregation})`).join('、')}\n\n## 结果\n\n${table}\n\n${mermaid ? `## 图表\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`` : ''}\n\n## 假设与限制\n\n${(plan.assumptions ?? []).map(item => `- ${item}`).join('\n') || '- 无'}\n`;
  await fs.writeFile(path.join(outputDir, 'report.md'), markdown, 'utf8');
  const htmlRows = rows.map(row => `<tr>${headers.map(header => `<td>${escapeHtml(formatNumber(row[header]))}</td>`).join('')}</tr>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>企业报表分析报告</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:32px;color:#18181b}main{max-width:1100px;margin:auto}h1{font-size:28px}h2{margin-top:30px;border-bottom:1px solid #ddd;padding-bottom:8px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:right}th:first-child,td:first-child{text-align:left}.summary{background:#f4f4f5;padding:16px;border-left:4px solid #2563eb}img{max-width:100%}</style><main><h1>企业报表分析报告</h1><h2>问题</h2><p>${escapeHtml(question)}</p><h2>结论</h2><p class="summary">${escapeHtml(summary)}</p>${chart ? '<h2>图表</h2><img src="chart.svg" alt="分析图表">' : ''}<h2>结果</h2><table><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${htmlRows}</tbody></table><h2>假设与限制</h2><ul>${(plan.assumptions ?? []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></main></html>`;
  await fs.writeFile(path.join(outputDir, 'report.html'), html, 'utf8');
  return report;
}

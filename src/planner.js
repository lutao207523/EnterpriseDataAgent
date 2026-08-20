import { asNumber, normalizeText } from './utils.js';

function inferColumnTypes(columns, rows) {
  return columns.map(column => {
    const values = rows.slice(0, 200).map(row => row[column]).filter(v => v !== '' && v !== null && v !== undefined);
    const numeric = values.filter(v => asNumber(v) !== null).length;
    const dates = values.filter(v => !Number.isNaN(Date.parse(String(v)))).length;
    const type = numeric >= values.length * 0.8 ? 'number' : dates >= values.length * 0.8 ? 'date' : 'text';
    return { name: column, type, sample: values.slice(0, 5) };
  });
}

export function profileDataset(dataset) {
  const { columns, rows } = dataset;
  const inferred = inferColumnTypes(columns, rows);
  return {
    rowCount: rows.length,
    columnCount: columns.length,
    columns: inferred.map(column => ({
      ...column,
      missing: rows.filter(row => row[column.name] === '' || row[column.name] === null || row[column.name] === undefined).length,
      unique: new Set(rows.map(row => String(row[column.name] ?? ''))).size,
    })),
  };
}

function queryContains(question, words) {
  const normalized = normalizeText(question);
  return words.some(word => normalized.includes(normalizeText(word)));
}

function isComprehensiveRequest(question) {
  return /(全面|综合|整体|概览|做数据分析|分析.*报告|报告.*分析|输出报告|生成报告|分析报告|分析.*(?:表格|报表|数据)|(?:表格|报表|数据).*分析)/i.test(String(question || ''));
}

function isTotalRequest(question) {
  return /(总营业额|总销售额|销售总额|营业总额|总收入|总金额|总和|合计|总计|一共|总共|总量)/i.test(String(question || ''));
}

function chooseMetricFields(profile, mappings, question) {
  const numeric = profile.columns.filter(column => column.type === 'number').map(column => column.name);
  const amount = numeric.find(field => /(销售额|销售金额|营业额|收入|营收|成交额|金额)/i.test(field));
  const quantity = numeric.find(field => /(销量|销售量|数量|件数|订单数|订单量)/i.test(field));
  const profit = numeric.find(field => /(利润|毛利|净利)/i.test(field));
  const requested = [];
  if (queryContains(question, ['销售金额', '销售额', '营业额', '收入', '营收', '成交额', '金额']) && amount) requested.push(amount);
  if (queryContains(question, ['不畅销', '畅销', '销量', '销售量', '卖得最好', '卖得最少']) && quantity) requested.push(quantity);
  if (queryContains(question, ['利润', '毛利', '净利']) && profit) requested.push(profit);
  if (requested.length) return [...new Set(requested)];
  const mapped = mappings.filter(item => item.semanticType === 'metric').map(item => item.sourceField).filter(field => numeric.includes(field));
  return [...new Set(mapped.length ? mapped : [amount, quantity, profit, numeric.find(field => !/(单价|价格|编号|代码)/i.test(field))])].filter(Boolean);
}

function preferredDimension(profile) {
  const text = profile.columns.filter(column => column.type === 'text').map(column => column.name);
  return text.find(field => /商品名称|产品名称|物品名称|名称/i.test(field))
    ?? text.find(field => /商品|产品|物品|分类|品类|区域|门店|部门/i.test(field))
    ?? text.find(field => !/编号|代码|id/i.test(field))
    ?? text[0];
}

function humanizeDimensions(dimensions, question, profile) {
  const requested = [...new Set(dimensions ?? [])].filter(Boolean);
  const explicitlyRequestsId = /(商品|产品|物品)?(?:编号|代码)|\bid\b|\bcode\b/i.test(String(question || ''));
  if (explicitlyRequestsId) return requested;
  const readable = preferredDimension(profile);
  const hasIdentifier = requested.some(field => /编号|代码|\bid\b|\bcode\b/i.test(field));
  const hasReadableName = requested.some(field => /名称|name/i.test(field));
  if (readable && (hasIdentifier || !requested.length)) {
    return [readable, ...requested.filter(field => !/编号|代码|\bid\b|\bcode\b|名称|name/i.test(field))];
  }
  if (hasReadableName) return [...requested.filter(field => /名称|name/i.test(field)), ...requested.filter(field => !/名称|name/i.test(field))];
  return requested;
}

function buildComprehensivePlan(question, profile, mappings) {
  const numeric = profile.columns.filter(column => column.type === 'number').map(column => column.name);
  const metricFields = [...new Set([
    numeric.find(field => /(销售额|销售金额|营业额|收入|营收|成交额|金额)/i.test(field)),
    numeric.find(field => /(销量|销售量|数量|件数|订单数|订单量)/i.test(field)),
    numeric.find(field => /(利润|毛利|净利)/i.test(field)),
    numeric.find(field => /(成本|费用)/i.test(field)),
  ])].filter(Boolean);
  if (!metricFields.length) metricFields.push(...chooseMetricFields(profile, mappings, question));
  const dimension = preferredDimension(profile);
  return {
    question, operation: 'group_by', responseMode: 'comprehensive',
    presentation: { chart: true, table: true, mappings: false, report: true },
    dimensions: dimension ? [dimension] : [],
    metrics: metricFields.map(field => ({ field, aggregation: 'sum' })),
    limit: 50, order: 'desc', fieldMappings: mappings,
    assumptions: ['自动选择业务实体作为分组维度，并汇总可识别的销售指标。', '图表展示首个核心指标；完整结果保存在报告中.'],
  };
}

export async function buildLocalPlan(question, profile, wiki) {
  const columns = profile.columns.map(column => column.name);
  const mappings = await wiki.search(question, columns);
  const numeric = profile.columns.filter(column => column.type === 'number').map(column => column.name);
  const text = profile.columns.filter(column => column.type === 'text').map(column => column.name);
  const date = profile.columns.filter(column => column.type === 'date').map(column => column.name);
  const mappedMetrics = mappings.filter(m => m.semanticType === 'metric').map(m => m.sourceField);
  const mappedDimensions = mappings.filter(m => ['dimension', 'time'].includes(m.semanticType)).map(m => m.sourceField);
  if (isComprehensiveRequest(question)) return buildComprehensivePlan(question, profile, mappings);
  const selectedMetrics = chooseMetricFields(profile, mappings, question);
  const metricFields = [...new Set(selectedMetrics.length ? selectedMetrics : (mappedMetrics.length ? mappedMetrics : [numeric[0]]))].filter(Boolean);
  const preferredEntity = text.find(field => /名称|name/i.test(field)) ?? text.find(field => !/编号|代码|id|code/i.test(field)) ?? text[0];
  const fallbackDimensions = queryContains(question, ['趋势', '月份', '时间'])
    ? [date[0]]
    : queryContains(question, ['最高', '最低', '最大', '最小', 'top', '排名', '哪个'])
      ? [preferredEntity]
      : [text[0]];
  const dimensionFields = humanizeDimensions(mappedDimensions.length ? mappedDimensions : fallbackDimensions, question, profile);
  if (!metricFields.length) throw new Error('未找到可以计算的数值字段。');
  const operation = isTotalRequest(question) ? 'total' : queryContains(question, ['最高', '最低', '最大', '最小', '最少', '不畅销', '畅销', '卖得最好', '卖得最少', 'top', '排名', '前十']) ? 'rank' : queryContains(question, ['趋势', '同比', '环比']) ? 'trend' : 'group_by';
  if (operation === 'total') {
    return {
      question, operation, responseMode: 'total', presentation: { chart: false, table: false, mappings: false, report: false },
      dimensions: [], metrics: [{ field: metricFields[0], aggregation: queryContains(question, ['平均', '均值']) ? 'avg' : 'sum' }],
      limit: 1, order: 'desc', fieldMappings: mappings,
      assumptions: ['对识别到的核心金额字段进行总计。'],
    };
  }
  const responseMode = operation === 'rank' && queryContains(question, ['哪个', '哪一个', '是哪', '什么商品', '什么产品', '物品', '商品', '产品']) ? 'entity' : 'analysis';
  const presentation = {
    chart: queryContains(question, ['生成图片', '生成图', '图表', '画图', '可视化', '柱状图', '折线图', '饼图', '趋势图']),
    table: queryContains(question, ['表格', '明细', '列出', '排名', '前十', 'top', '分别', '各个', '按']),
    mappings: queryContains(question, ['字段映射', '字段口径', '数据口径', '用了什么字段']),
    report: queryContains(question, ['生成报告', '分析报告', '输出报告', '导出', '下载报告']),
  };
  return {
    question,
    operation,
    responseMode,
    presentation,
    dimensions: dimensionFields,
    metrics: metricFields.map(field => ({ field, aggregation: queryContains(question, ['平均', '均值', 'average']) ? 'avg' : 'sum' })),
    limit: queryContains(question, ['前十', 'top10', 'top 10']) ? 10 : 50,
    order: operation === 'rank' && queryContains(question, ['最低', '最小', '最少', '不畅销', '卖得最少']) ? 'asc' : operation === 'rank' ? 'desc' : 'asc',
    fieldMappings: mappings,
    assumptions: [
      mappings.length ? '业务字段依据 LLM Wiki 映射。' : '未匹配到 Wiki 术语，使用数据类型和列顺序推断字段。',
      '默认对指标使用求和；问题包含“平均/均值”时使用平均值。',
    ],
  };
}

export function executePlan(dataset, plan) {
  const dimensions = plan.dimensions ?? [];
  const metrics = plan.metrics ?? [];
  const groups = new Map();
  for (const row of dataset.rows) {
    const dimensionValues = Object.fromEntries(dimensions.map(dimension => [dimension, String(row[dimension] ?? '未分类')]));
    const key = JSON.stringify(dimensionValues);
    const current = groups.get(key) ?? { dimensions: dimensionValues, metrics: {}, recordCount: 0 };
    let hasValue = false;
    for (const metric of metrics) {
      const value = asNumber(row[metric.field]);
      if (value === null) continue;
      hasValue = true;
      const state = current.metrics[metric.field] ?? { sum: 0, count: 0, min: value, max: value };
      state.sum += value; state.count += 1; state.min = Math.min(state.min, value); state.max = Math.max(state.max, value);
      current.metrics[metric.field] = state;
    }
    if (hasValue) { current.recordCount += 1; groups.set(key, current); }
  }
  const rows = [...groups.values()].map(group => ({
    ...(dimensions.length ? group.dimensions : { 范围: '全部' }),
    ...Object.fromEntries(metrics.map(metric => {
      const state = group.metrics[metric.field];
      return [metric.field, !state ? null : metric.aggregation === 'avg' ? state.sum / state.count : state.sum];
    })),
    记录数: group.recordCount,
  }));
  const metricName = metrics[0].field;
  if (plan.operation === 'rank') rows.sort((a, b) => plan.order === 'asc' ? a[metricName] - b[metricName] : b[metricName] - a[metricName]);
  else rows.sort((a, b) => String(a[dimensions[0] ?? '范围']).localeCompare(String(b[dimensions[0] ?? '范围']), 'zh-CN', { numeric: true }));
  return rows.slice(0, plan.limit ?? 50);
}

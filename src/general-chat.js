import { answerRuntimeQuestion } from './runtime-tools.js';

const SYSTEM_PROMPT = `你是一个本地企业数据分析 Agent，同时也是可靠、简洁的通用中文助手。
普通问题直接回答；只有用户明确询问已上传报表的数据时才讨论数据分析。
不知道的信息应明确说明，不要编造。回答保持简洁、自然。`;

export function isDataAnalysisRequest(question, hasFile) {
  const text = String(question || '').toLowerCase();
  const operation = /(统计|分析|计算|最高|最低|最大|最小|最少|不畅销|畅销|卖得最好|卖得最少|平均|均值|总和|合计|总计|总营业额|总销售额|销售总额|总收入|总金额|趋势|同比|环比|排名|第\s*[一二三四五六七八九十\d]+名|前\s*\d+|top|占比|分布|筛选|查找|列出|明细|图表|柱状图|折线图|饼图|画图|生成图|做个图|画个图|可视化|生成图片|生成报告|输出报告|导出)/i;
  const dataReference = /(这张表|这个表|当前表|刚才的表|上传的表|报表|表格|数据集|字段|哪一列|多少行)/i;
  const businessField = /(销售|销量|销售额|营业额|金额|收入|利润|成本|订单|商品|产品|物品|客户|区域|门店|部门|员工|库存|预算|回款|应收|应付|同比|环比|日期|月份|季度|年度)/i;
  if (dataReference.test(text)) return true;
  if (hasFile) return operation.test(text) && (businessField.test(text) || text.length <= 24);
  return operation.test(text) && businessField.test(text);
}

function builtInReply(question) {
  const text = String(question || '').trim();
  if (/^(你好|您好|嗨|hello|hi|早上好|下午好|晚上好|在吗)[！!。.?？\s]*$/i.test(text)) return '你好。我可以回答一般问题，也可以分析你上传的 CSV 或 Excel 报表。';
  if (/^(谢谢|感谢|多谢|thank you|thanks)[！!。\s]*$/i.test(text)) return '不客气。';
  if (/(你是谁|你是什么)/.test(text)) return '我是企业数据分析 Agent，可以进行普通对话，也可以调用报表分析工具处理 CSV 和 Excel 数据。';
  if (/(你能做什么|怎么使用|帮助|help)/i.test(text)) return '我可以回答一般问题；上传报表后，还可以进行字段识别、统计、排名、趋势分析，并按要求生成表格、图表或报告。';
  return null;
}

export async function answerGeneralQuestion({ question, history = [], settings }) {
  const runtimeAnswer = answerRuntimeQuestion(question);
  if (runtimeAnswer) return runtimeAnswer;
  const builtIn = builtInReply(question);
  if (builtIn) return { text: builtIn, source: 'built-in' };
  const localEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.baseUrl);
  if (!settings.model || (!settings.apiKey && !localEndpoint)) {
    return { text: '这是一个普通问题，但当前还没有配置通用大模型。请打开“模型设置”填写 API 地址、模型名称和 API Key；报表分析功能仍可正常使用。', source: 'unconfigured' };
  }
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-10).filter(item => ['user', 'assistant'].includes(item.role) && item.content).map(item => ({ role: item.role, content: String(item.content) })),
    { role: 'user', content: question },
  ];
  let response;
  try {
    response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
      body: JSON.stringify({ model: settings.model, messages, temperature: 0.3, stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const code = error?.cause?.code;
    const detail = code === 'UND_ERR_CONNECT_TIMEOUT' ? '连接超时' : code || error.message;
    throw new Error(`无法连接模型 API（${detail}），请检查 API 地址、网络或代理设置。`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `模型请求失败：HTTP ${response.status}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('模型没有返回文本内容。');
  return { text: String(text).trim(), source: 'model' };
}

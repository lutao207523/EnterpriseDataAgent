import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnterpriseReportAgent } from '../src/agent.js';
import { extractConversationChartSpec, isChartRequest, isConversationChartFollowUp } from '../src/conversation-chart.js';
import { readDataFile } from '../src/data-reader.js';
import { answerGeneralQuestion, isDataAnalysisRequest } from '../src/general-chat.js';
import { answerRuntimeQuestion, currentDateTimeTool } from '../src/runtime-tools.js';
import { createServer } from '../src/server.js';

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try { return await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function zipStored(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(text);
    const header = Buffer.alloc(30 + nameBuffer.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6); header.writeUInt16LE(0, 8);
    header.writeUInt32LE(0, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26); header.writeUInt16LE(0, 28); nameBuffer.copy(header, 30);
    local.push(header, data);
    const directory = Buffer.alloc(46 + nameBuffer.length);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8); directory.writeUInt16LE(0, 10); directory.writeUInt32LE(0, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(nameBuffer.length, 28);
    directory.writeUInt32LE(offset, 42); nameBuffer.copy(directory, 46);
    central.push(directory); offset += header.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

test('analyzes CSV and writes structured report artifacts', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'report-agent-'));
  const file = path.resolve('examples/sales.csv');
  const agent = new EnterpriseReportAgent({ cwd: process.cwd() });
  const report = await agent.analyze({ file, question: '按区域统计销售额和利润，找出销售额最高的区域并生成图表', outputDir: output });
  assert.equal(report.plan.dimensions[0], '区域');
  assert.equal(report.plan.metrics[0].field, '销售额');
  assert.equal(report.plan.metrics[1].field, '利润');
  assert.equal(report.plan.presentation.chart, true);
  assert.equal(report.resultTables[0].rows[0].利润, 51000);
  assert.match(report.summary, /华东/);
  for (const name of ['report.json', 'report.md', 'report.html', 'chart.svg', 'chart.mmd']) {
    assert.equal((await fs.stat(path.join(output, name))).isFile(), true);
  }
});

test('detects XLSX header below a merged title and removes total rows', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-xlsx-'));
  const file = path.join(dir, 'fixture.xlsx');
  const workbook = '<workbook xmlns:r="r"><sheets><sheet name="销售" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const sheet = '<worksheet><sheetData><row><c r="A1" t="str"><v>销售统计表</v></c></row><row><c r="A2" t="str"><v>商品名称</v></c><c r="B2" t="str"><v>销售金额</v></c></row><row><c r="A3" t="str"><v>商品A</v></c><c r="B3"><v>120</v></c></row><row><c r="A4" t="str"><v>商品B</v></c><c r="B4"><v>180</v></c></row><row><c r="A5" t="str"><v>合计</v></c><c r="B5"><v>300</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>';
  await fs.writeFile(file, zipStored({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/sheet1.xml': sheet }));
  const sheets = await readDataFile(file);
  assert.deepEqual(sheets.get('销售').columns, ['商品名称', '销售金额']);
  assert.deepEqual(sheets.get('销售').rows, [{ 商品名称: '商品A', 销售金额: 120 }, { 商品名称: '商品B', 销售金额: 180 }]);
});

test('entity ranking questions return the item name without amount or id', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'report-entity-'));
  const file = path.join(output, 'products.csv');
  await fs.writeFile(file, '商品编号,商品名称,销售金额\nSP001,商品A,120\nSP002,商品B,180\n', 'utf8');
  const agent = new EnterpriseReportAgent({ cwd: process.cwd() });
  const report = await agent.analyze({ file, question: '销售金额最高的是哪个商品', outputDir: output });
  assert.deepEqual(report.plan.dimensions, ['商品名称']);
  assert.equal(report.plan.responseMode, 'entity');
  assert.equal(report.plan.presentation.chart, false);
  assert.equal(report.plan.presentation.table, false);
  assert.equal(report.plan.presentation.report, false);
  assert.equal(report.summary, '销售金额最高的商品是“商品B”。');
  assert.equal(report.charts.length, 0);
});

test('general conversation does not trigger report analysis even when a file exists', async () => {
  assert.equal(isDataAnalysisRequest('你好', true), false);
  assert.equal(isDataAnalysisRequest('你是谁', true), false);
  assert.equal(isDataAnalysisRequest('销售金额最高的是哪个商品', true), true);
  assert.equal(isDataAnalysisRequest('哪个商品最不畅销', true), true);
  assert.equal(isDataAnalysisRequest('总营业额多少', true), true);

  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '你好' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.kind, 'chat');
    assert.match(body.summary, /你好/);
    assert.equal(body.presentation.chart, false);
  });
});

test('unconfigured general questions provide model setup guidance', async () => {
  const reply = await answerGeneralQuestion({
    question: '解释一下现金流是什么',
    settings: { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' },
  });
  assert.equal(reply.source, 'unconfigured');
  assert.match(reply.text, /模型设置/);
});

test('runtime date tool answers date and weekday without calling a model', async () => {
  const frozenNow = new Date('2026-08-16T03:04:05.000Z');
  const today = answerRuntimeQuestion('今天是几号', { now: frozenNow });
  const tomorrow = answerRuntimeQuestion('明天星期几', { now: frozenNow });
  const time = currentDateTimeTool.execute({ question: '现在几点', now: frozenNow });

  assert.equal(today.source, 'tool:get_current_datetime');
  assert.equal(today.text, '今天是2026年8月16日，星期日（北京时间）。');
  assert.equal(tomorrow.text, '明天是2026年8月17日，星期一（北京时间）。');
  assert.equal(time, '现在是2026年8月16日，星期日 11:04:05（北京时间）。');

  const reply = await answerGeneralQuestion({
    question: '当前日期是什么？',
    settings: { baseUrl: '', model: '', apiKey: '' },
  });
  assert.equal(reply.source, 'tool:get_current_datetime');
  assert.match(reply.text, /^今天是\d{4}年\d{1,2}月\d{1,2}日，星期/);
});

test('data questions without an uploaded report ask for a file', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '销售金额最高的是哪个商品' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.kind, 'chat');
    assert.match(body.summary, /上传|拖入/);
  });
});

test('extracts chart data from a markdown table in conversation history', () => {
  const history = [{
    role: 'assistant',
    content: '分类汇总如下：\n\n| 商品分类 | 销售金额（元） |\n| --- | --- |\n| 数码电子 | 170,344 |\n| 家用电器 | 98,210 |\n| 食品生鲜 | 45,320 |',
  }];
  assert.equal(isChartRequest('把上面的数据生成柱状图'), true);
  assert.equal(isChartRequest('生成图'), true);
  assert.equal(isConversationChartFollowUp('生成图'), true);
  assert.equal(isConversationChartFollowUp('把上面的数据画成饼图'), true);
  const spec = extractConversationChartSpec({ question: '把上面的数据生成柱状图', history });
  assert.equal(spec.type, 'bar');
  assert.equal(spec.labelName, '商品分类');
  assert.equal(spec.valueName, '销售金额（元）');
  assert.deepEqual(spec.data[0], { label: '数码电子', value: 170344 });
});

test('minimum ranking questions sort ascending and answer with the item name', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'report-minimum-'));
  const file = path.join(output, 'products.csv');
  await fs.writeFile(file, '商品编号,商品名称,销售金额\nSP001,商品A,120\nSP002,商品B,180\n', 'utf8');
  const agent = new EnterpriseReportAgent({ cwd: process.cwd() });
  const report = await agent.analyze({ file, question: '分析最低销售金额商品', outputDir: output });
  assert.equal(report.plan.order, 'asc');
  assert.deepEqual(report.plan.dimensions, ['商品名称']);
  assert.equal(report.summary, '销售金额最低的商品是“商品A”。');
});

test('chart requests create a real SVG from conversation data without an uploaded file', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '把上面的数据生成饼图图片',
        history: [{ role: 'assistant', content: '| 商品分类 | 销售金额 |\n| --- | --- |\n| 数码电子 | 170344 |\n| 家用电器 | 98210 |\n| 食品生鲜 | 45320 |' }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.kind, 'analysis');
    assert.equal(body.presentation.chart, true);
    assert.match(body.artifacts.chart, /chart\.svg$/);
    const image = await fetch(`${baseUrl}${body.artifacts.chart}`);
    assert.equal(image.status, 200);
    assert.match(await image.text(), /<svg[\s\S]*<path/);
  });
});

test('short chart follow-ups use conversation data even when a report is still attached', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '生成图', fileName: 'still-attached.csv', fileBase64: Buffer.from('字段,数值\n无关,1\n').toString('base64'),
        history: [{ role: 'assistant', content: '| 商品分类 | 销售金额 |\n| --- | --- |\n| 数码电子 | 170344 |\n| 家用电器 | 98210 |' }],
      }),
    });
    const body = await response.json();
    assert.equal(body.kind, 'analysis');
    assert.equal(body.plan.operation, 'conversation_chart');
    assert.match(body.summary, /商品分类.*销售金额/);
    assert.equal(body.presentation.chart, true);
  });
});

test('comprehensive analysis reports totals, best and worst items with chart and report', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'report-comprehensive-'));
  const file = path.join(output, 'business.csv');
  await fs.writeFile(file, '商品编号,商品名称,本月销量(件),销售金额(元)\nSP001,商品A,10,120\nSP002,商品B,20,180\n', 'utf8');
  const agent = new EnterpriseReportAgent({ cwd: process.cwd() });
  const report = await agent.analyze({ file, question: '做数据分析和输出报告给我', outputDir: output });
  assert.equal(report.plan.responseMode, 'comprehensive');
  assert.deepEqual(report.plan.dimensions, ['商品名称']);
  assert.deepEqual(report.plan.metrics.map(item => item.field), ['销售金额(元)', '本月销量(件)']);
  assert.deepEqual(report.plan.presentation, { chart: true, table: true, mappings: false, report: true });
  assert.match(report.summary, /总计为 300/);
  assert.match(report.summary, /最高.*商品B/);
  assert.match(report.summary, /最低.*商品A/);
  assert.match(report.summary, /销量最高.*商品B/);
  assert.equal((await fs.stat(path.join(output, 'chart.svg'))).isFile(), true);
  assert.equal((await fs.stat(path.join(output, 'report.html'))).isFile(), true);
});

test('total revenue and least popular item use the correct metrics', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'report-business-questions-'));
  const file = path.join(output, 'business.csv');
  await fs.writeFile(file, '商品编号,商品名称,本月销量(件),销售金额(元)\nSP001,商品A,5,120\nSP002,商品B,20,180\n', 'utf8');
  const agent = new EnterpriseReportAgent({ cwd: process.cwd() });
  const total = await agent.analyze({ file, question: '总营业额多少', outputDir: path.join(output, 'total') });
  assert.equal(total.plan.operation, 'total');
  assert.equal(total.summary, '销售金额总计为 300。');
  const unpopular = await agent.analyze({ file, question: '哪个商品最不畅销', outputDir: path.join(output, 'unpopular') });
  assert.equal(unpopular.plan.metrics[0].field, '本月销量(件)');
  assert.equal(unpopular.plan.order, 'asc');
  assert.equal(unpopular.summary, '本月销量最低的商品是“商品A”。');
});

test('generic report analysis prioritizes product names over product ids', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'report-readable-dimension-'));
  const file = path.join(output, 'products.csv');
  await fs.writeFile(file, '商品编号,商品名称,本月销量(件),销售金额(元)\nSP001,商品A,5,120\nSP002,商品B,20,180\n', 'utf8');
  const agent = new EnterpriseReportAgent({ cwd: process.cwd() });
  const report = await agent.analyze({ file, question: '分析该表格数据', outputDir: output });
  assert.equal(report.plan.responseMode, 'comprehensive');
  assert.deepEqual(report.plan.dimensions, ['商品名称']);
  assert.doesNotMatch(report.summary, /SP00/);
  assert.match(report.summary, /商品A|商品B/);
});

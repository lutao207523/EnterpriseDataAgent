import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EnterpriseReportAgent } from './agent.js';
import { generateConversationChart, isChartRequest, isConversationChartFollowUp } from './conversation-chart.js';
import { answerGeneralQuestion, isDataAnalysisRequest } from './general-chat.js';
import { getModelSettings, getPublicModelSettings, saveModelSettings } from './settings.js';
import { ROOT, ensureDir } from './utils.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3210);
const WEB_ROOT = path.join(ROOT, 'web');
const RUNS_ROOT = path.join(ROOT, 'runs');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function safeFileName(name) {
  const base = path.basename(String(name || 'report.csv')).replace(/[^\p{L}\p{N}._-]/gu, '_');
  return base || 'report.csv';
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES * 1.4) throw new Error(`上传内容超过限制（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveFile(res, file, root) {
  const resolved = path.resolve(file);
  if (!contained(root, resolved)) return json(res, 403, { error: '路径不在允许目录内。' });
  try {
    const content = await fs.readFile(resolved);
    res.writeHead(200, { 'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(content);
  } catch {
    json(res, 404, { error: '文件不存在。' });
  }
}

async function createRun() {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = await ensureDir(path.join(RUNS_ROOT, runId));
  const reportDir = await ensureDir(path.join(runDir, 'report'));
  return { runId, runDir, reportDir };
}

async function analyze(req, res) {
  try {
    const body = await readJsonBody(req);
    const question = String(body.question || '').trim();
    if (!question) return json(res, 400, { error: '请输入问题。' });
    const hasFile = Boolean(body.fileName && body.fileBase64);
    const dataRequest = isDataAnalysisRequest(question, hasFile);

    if (isChartRequest(question) && (!hasFile || isConversationChartFollowUp(question))) {
      const { runId, reportDir } = await createRun();
      const chart = await generateConversationChart({
        question,
        history: body.history,
        settings: await getModelSettings(),
        outputDir: reportDir,
      });
      if (!chart && !hasFile) {
        return json(res, 200, {
          kind: 'chat',
          summary: '我可以生成数据图表图片，但当前对话里没有足够的数值数据。请先提供数据，或者上传 CSV/Excel 报表。',
          source: 'chart-tool',
          presentation: { chart: false, table: false, mappings: false, report: false },
        });
      }
      if (chart) {
        const base = `/runs/${encodeURIComponent(runId)}/report`;
        return json(res, 200, {
          kind: 'analysis', runId, summary: chart.summary, rows: chart.rows,
          presentation: { chart: true, table: false, mappings: false, report: false },
          fieldMappings: [], plan: { operation: 'conversation_chart', presentation: { chart: true, table: false, mappings: false, report: false } },
          artifacts: { html: null, json: `${base}/chart.json`, markdown: null, chart: `${base}/chart.svg` },
        });
      }
    }

    if (!dataRequest) {
      const reply = await answerGeneralQuestion({ question, history: body.history, settings: await getModelSettings() });
      return json(res, 200, {
        kind: 'chat',
        summary: reply.text,
        source: reply.source,
        presentation: { chart: false, table: false, mappings: false, report: false },
      });
    }

    if (!hasFile) {
      return json(res, 200, {
        kind: 'chat',
        summary: '这个问题需要读取报表数据。请先在左侧拖入 CSV 或 Excel 文件，然后再发送问题。',
        source: 'agent',
        presentation: { chart: false, table: false, mappings: false, report: false },
      });
    }

    const fileBuffer = Buffer.from(body.fileBase64, 'base64');
    if (fileBuffer.length > MAX_UPLOAD_BYTES) return json(res, 413, { error: '文件过大。' });
    if (!/\.(csv|tsv|xlsx|xlsm|xlsb)$/i.test(body.fileName)) return json(res, 400, { error: '只支持 CSV、TSV、XLSX、XLSM 和 XLSB。' });
    const { runId, runDir, reportDir } = await createRun();
    const inputDir = await ensureDir(path.join(runDir, 'input'));
    const inputFile = path.join(inputDir, safeFileName(body.fileName));
    await fs.writeFile(inputFile, fileBuffer);
    const agent = new EnterpriseReportAgent({ cwd: ROOT, modelSettings: await getModelSettings() });
    const report = await agent.analyze({ file: inputFile, question, sheet: body.sheet, outputDir: reportDir });
    const base = `/runs/${encodeURIComponent(runId)}/report`;
    json(res, 200, {
      kind: 'analysis', runId, summary: report.summary, profile: report.profile, plan: report.plan, presentation: report.plan.presentation,
      fieldMappings: report.fieldMappings, rows: report.resultTables?.[0]?.rows ?? [],
      artifacts: { html: `${base}/report.html`, json: `${base}/report.json`, markdown: `${base}/report.md`, chart: report.charts.length ? `${base}/chart.svg` : null },
    });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, name: 'Enterprise Data Agent' });
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, await getPublicModelSettings());
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      try { return json(res, 200, await saveModelSettings(await readJsonBody(req))); }
      catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze') return analyze(req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
      const relative = decodeURIComponent(url.pathname.slice('/runs/'.length));
      return serveFile(res, path.join(RUNS_ROOT, relative), RUNS_ROOT);
    }
    if (req.method === 'GET') {
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      return serveFile(res, path.join(WEB_ROOT, relative), WEB_ROOT);
    }
    json(res, 405, { error: 'Method not allowed' });
  });
}

async function start() {
  await ensureDir(RUNS_ROOT);
  const server = createServer();
  server.listen(PORT, HOST, () => {
    const address = `http://${HOST}:${PORT}`;
    console.log(`\n企业数据 Agent 已启动：${address}`);
    console.log('关闭此窗口即可停止服务。\n');
    if (process.env.NO_OPEN !== '1' && process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '', address], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
  });
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) await start();

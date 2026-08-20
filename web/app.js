const state = { file: null, analyzing: false, history: [] };
const $ = selector => document.querySelector(selector);
const conversation = $('#conversation');
const fileInput = $('#file-input');
const dropZone = $('#drop-zone');
const question = $('#question');
const sendButton = $('#send-button');
const settingsDialog = $('#settings-dialog');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function setFile(file) {
  if (!file) {
    state.file = null; fileInput.value = ''; $('#file-card').hidden = true; dropZone.hidden = false;
    $('#source-status').classList.remove('ready'); $('#active-source').textContent = '可直接聊天，也可以上传报表进行分析';
    return;
  }
  if (!/\.(csv|tsv|xlsx|xlsm|xlsb)$/i.test(file.name)) return addAssistantMessage('请选择 CSV、TSV、XLSX、XLSM 或 XLSB 文件。', 'error-message');
  state.file = file; $('#file-name').textContent = file.name; $('#file-size').textContent = formatSize(file.size);
  $('#file-card').hidden = false; dropZone.hidden = true; $('#source-status').classList.add('ready');
  $('#active-source').textContent = `${file.name} · ${formatSize(file.size)}`;
}

function addUserMessage(text) {
  const node = document.createElement('div'); node.className = 'message user-message';
  node.innerHTML = `<div class="message-body"><p></p></div>`; node.querySelector('p').textContent = text;
  conversation.append(node); scrollToBottom();
}

function addAssistantMessage(text, className = '') {
  const node = document.createElement('div'); node.className = 'message assistant-message';
  node.innerHTML = `<div class="avatar">AI</div><div class="message-body"><p class="${className}"></p></div>`;
  node.querySelector('p').textContent = text; conversation.append(node); scrollToBottom(); return node;
}

function addLoading() {
  const node = document.createElement('div'); node.className = 'message assistant-message';
  node.innerHTML = '<div class="avatar">AI</div><div class="message-body"><div class="loading"><span class="spinner"></span><span>Agent 正在处理…</span></div></div>';
  conversation.append(node); scrollToBottom(); return node;
}

function scrollToBottom() { requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; }); }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

function renderTable(rows) {
  if (!rows.length) return '<p>没有返回数据行。</p>';
  const headers = Object.keys(rows[0]);
  return `<div class="table-scroll"><table class="result-table"><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map(h => `<td>${escapeHtml(formatValue(row[h]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function formatValue(value) { return typeof value === 'number' ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : String(value ?? ''); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]); }

function renderResult(data) {
  if (data.kind === 'chat') return addAssistantMessage(data.summary);
  const node = document.createElement('div'); node.className = 'message assistant-message';
  const presentation = data.presentation || {};
  const mappings = (data.fieldMappings || []).map(item => `<div class="mapping-item"><strong>${escapeHtml(item.input)} → ${escapeHtml(item.sourceField)}</strong><span>${escapeHtml(item.semanticType)} · 置信度 ${Math.round((item.confidence || 0) * 100)}%</span></div>`).join('') || '<p>未使用 Wiki 字段映射。</p>';
  const panels = [];
  if (presentation.chart && data.artifacts.chart) panels.push({ id: 'chart', label: '图表', content: `<img class="chart-image" src="${data.artifacts.chart}" alt="分析图表">` });
  if (presentation.table) panels.push({ id: 'table', label: '数据表', content: renderTable(data.rows) });
  if (presentation.mappings) panels.push({ id: 'mapping', label: '字段映射', content: `<div class="mapping-list">${mappings}</div>` });
  const tabMarkup = panels.length ? `<div class="result-tabs">${panels.map((panel, index) => `<button class="${index === 0 ? 'active' : ''}" data-tab="${panel.id}">${panel.label}</button>`).join('')}</div>${panels.map((panel, index) => `<div class="result-content" data-panel="${panel.id}" ${index === 0 ? '' : 'hidden'}>${panel.content}</div>`).join('')}` : '';
  const reportLinks = presentation.report ? `<div class="artifact-links"><a href="${data.artifacts.html}" target="_blank">打开完整报告</a><a href="${data.artifacts.json}" target="_blank">查看 JSON</a><a href="${data.artifacts.markdown}" target="_blank">查看 Markdown</a></div>` : '';
  node.innerHTML = `<div class="avatar">AI</div><div class="message-body"><section class="analysis-result"><div class="result-summary"><h3>分析结论</h3><p>${escapeHtml(data.summary)}</p></div>${tabMarkup}</section>${reportLinks}</div>`;
  node.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    node.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button));
    node.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
  }));
  conversation.append(node); scrollToBottom();
}

function resultHistoryContent(data) {
  if (data.kind !== 'analysis' || !data.rows?.length) return data.summary;
  const rows = data.rows.slice(0, 20);
  const headers = Object.keys(rows[0]);
  const table = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${headers.map(header => formatValue(row[header])).join(' | ')} |`).join('\n')}`;
  return `${data.summary}\n\n${table}`;
}

async function analyze() {
  const text = question.value.trim();
  if (state.analyzing) return;
  if (!text) return question.focus();
  const history = state.history.slice(-10);
  state.analyzing = true; sendButton.disabled = true; addUserMessage(text); state.history.push({ role: 'user', content: text }); question.value = ''; resizeTextarea();
  const loading = addLoading();
  try {
    const fileBase64 = state.file ? await fileToBase64(state.file) : null;
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: state.file?.name, fileBase64, question: text, history }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    loading.remove(); renderResult(data); state.history.push({ role: 'assistant', content: resultHistoryContent(data) });
  } catch (error) {
    loading.remove(); addAssistantMessage(`处理失败：${error.message}`, 'error-message');
  } finally { state.analyzing = false; sendButton.disabled = false; question.focus(); }
}

function resizeTextarea() { question.style.height = 'auto'; question.style.height = `${Math.min(question.scrollHeight, 150)}px`; }

fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
$('#remove-file').addEventListener('click', () => setFile(null));
dropZone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') fileInput.click(); });
for (const eventName of ['dragenter', 'dragover']) dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.remove('dragging'); });
dropZone.addEventListener('drop', event => setFile(event.dataTransfer.files[0]));
sendButton.addEventListener('click', analyze);
question.addEventListener('input', resizeTextarea);
question.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); analyze(); } });
document.querySelectorAll('.suggestions button').forEach(button => button.addEventListener('click', () => { question.value = button.textContent; resizeTextarea(); question.focus(); }));
$('#new-analysis').addEventListener('click', () => {
  setFile(null); question.value = ''; state.history = [];
  conversation.querySelectorAll('.message:not(:first-child)').forEach(node => node.remove());
});

async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    const data = await response.json();
    $('#api-base-url').value = data.baseUrl || 'https://api.openai.com/v1';
    $('#api-model').value = data.model || '';
    $('#model-status').textContent = data.configured ? '已配置' : '未配置';
    $('#model-status').classList.toggle('ready', data.configured);
    $('#model-description').textContent = data.configured ? `当前模型：${data.model}` : '基础问候可直接使用，更多通用问题需要配置模型。';
  } catch { $('#model-description').textContent = '暂时无法读取模型配置。'; }
}

$('#open-settings').addEventListener('click', () => { $('#settings-error').textContent = ''; settingsDialog.showModal(); });
$('#close-settings').addEventListener('click', () => settingsDialog.close());
$('#cancel-settings').addEventListener('click', () => settingsDialog.close());
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#settings-error').textContent = '';
  try {
    const response = await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: $('#api-base-url').value, model: $('#api-model').value, apiKey: $('#api-key').value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    $('#api-key').value = ''; settingsDialog.close(); await loadSettings();
    addAssistantMessage(data.configured ? '通用模型已配置，可以回答更多一般问题。' : '设置已保存。当前未填写模型名称。');
  } catch (error) { $('#settings-error').textContent = error.message; }
});

loadSettings();

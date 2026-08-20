# Enterprise Report Agent

这是从 Craft Agents 的 Pi Agent/工具注册思路中抽出的轻量化企业数据 Agent。它既能进行基础对话和通用问答，也能在识别到报表分析意图后调用 CSV/Excel 工具。项目提供本地图形界面，可拖拽上传报表并通过聊天框输入问题。

## 能力

- 用自然语言询问销售额、利润、区域、产品、同比、环比等问题。
- 普通聊天不会误触发报表分析；通用知识问题可接入 OpenAI 兼容模型。
- 对话中已有表格或数值数据时，可继续要求生成柱状图、折线图或饼图图片，无需重复上传文件。
- 自动发现 CSV、TSV、XLSX、XLSM 和部分 XLSB 文件。
- 通过 `wiki/fields.json` 或 LLM Wiki 进行业务字段和指标匹配。
- 自动选择剖析、聚合、排名和趋势分析。
- 生成 `report.md`、`report.html`、`report.json`、`chart.svg` 和 Mermaid 图表源码。
- 可选接入 `@earendil-works/pi-coding-agent`；未安装时使用本地确定性规划器。

## 图形界面运行

最简单的方法：双击项目根目录中的 `start-app.vbs`。程序会在后台启动本地服务并自动打开浏览器，不显示黑色命令行窗口。

需要停止后台服务时，双击 `stop-app.vbs`。

`start-app.cmd` 保留用于排查启动错误，它会显示服务日志，因此会出现黑色命令行窗口。

也可以在 PowerShell 中运行：

```powershell
cd C:\Users\admin\Documents\Codex\2026-08-14\craft-agent-agent-csv-excel-agent
node src/server.js
```

然后访问：

```text
http://127.0.0.1:3210
```

不上传文件时可以直接进行基础聊天。通用知识问答需要在左侧“模型设置”中填写 OpenAI 兼容 API 地址、模型名称和 API Key。拖入 CSV/Excel 文件后，在底部聊天框输入数据问题；每次分析结果保存在 `runs/` 目录。

## 命令行运行

```powershell
node src/cli.js examples/sales.csv "2025年各区域销售额和利润，并找出销售额最高的区域"
```

命令行也可以交互运行：

```powershell
node src/cli.js examples/sales.csv
```

结果默认写入 `output/`。

## 基于 Craft Agents 的保留和删除

保留：Pi Agent SDK 适配、工具定义/白名单、会话式 Prompt、工作区文件边界和结构化输出思想。

删除：Electron UI、Craft 文档工具、浏览器工具、消息渠道、代码编辑工具、MCP 来源管理和多会话工作流。当前版本专注企业报表分析闭环。

## LLM Wiki

默认读取 `wiki/fields.json`。配置 `LLM_WIKI_URL` 后，Agent 会向 `${LLM_WIKI_URL}/search` 发送 `{ query, candidates }`，请求头使用 `Authorization: Bearer <LLM_WIKI_TOKEN>`。

返回格式为：

```json
{ "mappings": [{ "input": "销售额", "sourceField": "销售额", "semanticType": "metric", "confidence": 0.98, "evidence": ["wiki"] }] }
```

## Pi Agent SDK

安装可选依赖后，设置 `PI_API_KEY` 和 `PI_MODEL` 即可启用 SDK 规划。SDK 不可用、模型调用失败或没有密钥时，会自动回退到本地规划器，不影响本地数据分析。

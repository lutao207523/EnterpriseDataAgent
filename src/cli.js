#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { EnterpriseReportAgent } from './agent.js';
import { parseArgs } from './utils.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let file = args.files[0];
    if (!file) file = path.resolve((await rl.question('CSV/Excel 文件路径：')).trim().replace(/^"|"$/g, ''));
    if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
    const question = args.question || (await rl.question('请输入业务问题：')).trim();
    if (!question) throw new Error('业务问题不能为空。');
    console.log('\n正在读取数据、识别字段并执行分析...');
    const agent = new EnterpriseReportAgent({ cwd: process.cwd() });
    const report = await agent.analyze({ file, question, outputDir: args.output });
    console.log(`\n结论：${report.summary}`);
    console.log(`报告：${path.join(args.output, 'report.html')}`);
    console.log(`JSON：${path.join(args.output, 'report.json')}`);
  } finally {
    rl.close();
  }
}

main().catch(error => { console.error(`\n分析失败：${error.message}`); process.exitCode = 1; });

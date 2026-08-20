import path from 'node:path';
import { readDataFile } from './data-reader.js';
import { LlmWikiClient } from './llm-wiki.js';
import { PiAgentPlanner } from './pi-agent-adapter.js';
import { executePlan, profileDataset } from './planner.js';
import { writeReport } from './report.js';

export class EnterpriseReportAgent {
  constructor(options = {}) {
    this.wiki = options.wiki ?? new LlmWikiClient(options.wikiOptions);
    this.planner = options.planner ?? new PiAgentPlanner({ wiki: this.wiki, cwd: options.cwd, modelSettings: options.modelSettings });
  }

  async analyze({ file, question, sheet, outputDir }) {
    const workbook = await readDataFile(path.resolve(file));
    if (!workbook.size) throw new Error('文件中没有可读取的数据表。');
    const selectedSheet = sheet && workbook.has(sheet) ? sheet : workbook.keys().next().value;
    const dataset = workbook.get(selectedSheet);
    const maxRows = Number(process.env.MAX_ROWS || 200000);
    if (dataset.rows.length > maxRows) dataset.rows = dataset.rows.slice(0, maxRows);
    const profile = profileDataset(dataset);
    const plan = await this.planner.plan(question, profile);
    const rows = executePlan(dataset, plan);
    return writeReport({
      outputDir: path.resolve(outputDir), question, source: path.resolve(file),
      sheet: selectedSheet, profile, plan, rows,
    });
  }
}

import path from 'node:path';
import { buildLocalPlan } from './planner.js';
import { createPlanningTools } from './pi-tools.js';

const SYSTEM_PROMPT = `你是企业报表 CSV/Excel 数据分析 Agent。你的任务是把业务问题转换为严格的 JSON 分析计划。
只能使用提供的字段，不得虚构字段。只允许只读分析。输出必须是 JSON，包含 operation、dimensions、metrics、limit、order、assumptions。`;

export class PiAgentPlanner {
  constructor({ wiki, cwd = process.cwd(), modelSettings }) {
    this.wiki = wiki;
    this.cwd = path.resolve(cwd);
    this.modelSettings = modelSettings;
  }

  async plan(question, profile) {
    const configured = this.modelSettings ?? {
      apiKey: process.env.PI_API_KEY,
      model: process.env.PI_MODEL,
      baseUrl: process.env.PI_BASE_URL,
      provider: process.env.PI_PROVIDER,
    };
    if (!configured.apiKey || !configured.model) return buildLocalPlan(question, profile, this.wiki);
    try {
      const sdk = await import('@earendil-works/pi-coding-agent');
      if (typeof sdk.createAgentSession !== 'function') throw new Error('createAgentSession is unavailable');
      const authStorage = sdk.AuthStorage.inMemory();
      const provider = configured.provider || 'enterprise-agent-model';
      authStorage.set(provider, { type: 'api_key', key: configured.apiKey });
      const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
      if (configured.baseUrl) {
        modelRegistry.registerProvider(provider, {
          name: 'Enterprise Agent Model',
          baseUrl: configured.baseUrl.replace(/\/$/, ''),
          apiKey: configured.apiKey,
          api: 'openai-completions',
          models: [{
            id: configured.model,
            name: configured.model,
            reasoning: /reasoner|reasoning/i.test(configured.model),
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 64_000,
            maxTokens: 8_192,
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          }],
        });
      }
      const model = modelRegistry.find(provider, configured.model) ?? modelRegistry.getAll().find(item => item.id === configured.model);
      if (!model) throw new Error(`Pi model not found: ${provider}/${configured.model}`);
      const customTools = createPlanningTools(profile, this.wiki);
      const { session } = await sdk.createAgentSession({
        cwd: this.cwd,
        authStorage,
        modelRegistry,
        sessionManager: sdk.SessionManager.inMemory(),
        model,
        customTools,
        tools: customTools.map(tool => tool.name),
      });
      const internal = session;
      if (internal?.agent?.state) internal.agent.state.systemPrompt = SYSTEM_PROMPT;
      if ('_baseSystemPrompt' in internal) internal._baseSystemPrompt = SYSTEM_PROMPT;
      if ('_rebuildSystemPrompt' in internal) internal._rebuildSystemPrompt = () => SYSTEM_PROMPT;
      let text = '';
      let done;
      const finished = new Promise(resolve => { done = resolve; });
      const unsubscribe = session.subscribe(event => {
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const content = event.message.content;
          text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(item => item.type === 'text').map(item => item.text ?? '').join('') : text;
        }
        if (event.type === 'agent_end') done();
      });
      const prompt = `问题：${question}\n\n先调用 inspect_schema 和 resolve_business_fields，再返回严格 JSON 分析计划。`;
      await session.prompt(prompt);
      await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('Pi planning timed out')), 60_000))]);
      unsubscribe();
      session.dispose();
      const match = String(text ?? '').match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Pi did not return a JSON plan');
      const plan = JSON.parse(match[0]);
      const localPlan = await buildLocalPlan(question, profile, this.wiki);
      const allowed = new Set(profile.columns.map(column => column.name));
      for (const field of [...(plan.dimensions ?? []), ...(plan.metrics ?? []).map(m => m.field)]) {
        if (!allowed.has(field)) throw new Error(`Pi returned unknown field: ${field}`);
      }
      plan.question = question;
      plan.presentation = localPlan.presentation;
      plan.responseMode = localPlan.responseMode;
      plan.order = localPlan.order;
      plan.limit = plan.limit ?? localPlan.limit;
      if (localPlan.responseMode !== 'analysis' || localPlan.operation === 'trend') {
        plan.operation = localPlan.operation;
        plan.dimensions = localPlan.dimensions;
        plan.metrics = localPlan.metrics;
        plan.order = localPlan.order;
      }
      const explicitlyRequestsId = /(商品|产品|物品)?(?:编号|代码)|\bid\b|\bcode\b/i.test(question);
      const readableDimension = profile.columns.find(column => /商品名称|产品名称|物品名称|名称|name/i.test(column.name))?.name;
      const hasIdentifierDimension = (plan.dimensions ?? []).some(field => /编号|代码|\bid\b|\bcode\b/i.test(field));
      if (!explicitlyRequestsId && readableDimension && hasIdentifierDimension) {
        plan.dimensions = [readableDimension, ...(plan.dimensions ?? []).filter(field => !/编号|代码|\bid\b|\bcode\b|名称|name/i.test(field))];
      }
      plan.fieldMappings = localPlan.fieldMappings;
      return plan;
    } catch (error) {
      console.warn(`[pi] SDK planning failed, using local planner: ${error.message}`);
      return buildLocalPlan(question, profile, this.wiki);
    }
  }
}

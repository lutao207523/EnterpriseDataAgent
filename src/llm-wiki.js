import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, normalizeText } from './utils.js';

function similarity(a, b) {
  const left = normalizeText(a), right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.82;
  const leftSet = new Set(left), rightSet = new Set(right);
  const overlap = [...leftSet].filter(ch => rightSet.has(ch)).length;
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

export class LlmWikiClient {
  constructor(options = {}) {
    this.url = options.url ?? process.env.LLM_WIKI_URL;
    this.token = options.token ?? process.env.LLM_WIKI_TOKEN;
    this.localFile = options.localFile ?? path.join(ROOT, 'wiki', 'fields.json');
    this.localTerms = null;
  }

  async loadLocalTerms() {
    if (!this.localTerms) {
      const parsed = JSON.parse(await fs.readFile(this.localFile, 'utf8'));
      this.localTerms = parsed.terms ?? [];
    }
    return this.localTerms;
  }

  async search(query, candidates = []) {
    if (this.url) {
      try {
        const response = await fetch(`${this.url.replace(/\/$/, '')}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
          body: JSON.stringify({ query, candidates }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`LLM Wiki HTTP ${response.status}`);
        const data = await response.json();
        if (Array.isArray(data.mappings)) return data.mappings;
      } catch (error) {
        console.warn(`[wiki] remote lookup failed, using local wiki: ${error.message}`);
      }
    }
    return this.resolveLocal(query, candidates);
  }

  async resolveLocal(query, candidates) {
    const terms = await this.loadLocalTerms();
    const mappings = [];
    for (const term of terms) {
      const words = [term.name, ...(term.aliases ?? [])];
      const mentioned = words.some(word => normalizeText(query).includes(normalizeText(word)));
      if (!mentioned) continue;
      const ranked = candidates.map(sourceField => ({ sourceField, score: Math.max(...words.map(word => similarity(word, sourceField))) })).sort((a, b) => b.score - a.score);
      if (ranked[0]?.score >= 0.35) {
        mappings.push({
          input: term.name,
          sourceField: ranked[0].sourceField,
          semanticType: term.semanticType,
          confidence: Number(ranked[0].score.toFixed(3)),
          evidence: [`local-wiki:${words.join('|')}`],
          formula: term.formula,
        });
      }
    }
    return mappings;
  }
}

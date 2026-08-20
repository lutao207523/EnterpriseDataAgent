function result(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: isError ? { isError: true } : {} };
}

export function createPlanningTools(profile, wiki) {
  return [
    {
      name: 'inspect_schema',
      label: 'Inspect Report Schema',
      description: 'Inspect CSV/Excel columns, inferred types, row count, missing values and samples before choosing fields.',
      promptSnippet: 'Call inspect_schema before planning an analysis over the attached report.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return result(profile); },
    },
    {
      name: 'resolve_business_fields',
      label: 'Resolve Business Fields',
      description: 'Search LLM Wiki and map business terms in a question to actual report fields.',
      promptSnippet: 'Use resolve_business_fields to ground dimensions and metrics in LLM Wiki definitions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The business question or field phrase.' } },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        try { return result(await wiki.search(params.query, profile.columns.map(column => column.name))); }
        catch (error) { return result(error.message, true); }
      },
    },
  ];
}

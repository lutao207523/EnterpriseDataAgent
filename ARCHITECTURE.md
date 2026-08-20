# Architecture

## Data flow

1. `src/server.js` and `web/` provide the local drag-and-drop chat interface; `src/cli.js` remains available for terminal use.
2. `src/data-reader.js` reads CSV/TSV or extracts XLSX XML into rows.
3. `src/planner.js` profiles columns and creates a validated analysis plan.
4. `src/llm-wiki.js` grounds business terms against a remote LLM Wiki or local dictionary.
5. `src/pi-agent-adapter.js` optionally lets Pi Agent SDK choose `inspect_schema` and `resolve_business_fields`; it falls back to the deterministic local planner when unavailable.
6. `src/planner.js` executes only validated read-only aggregation operations.
7. `src/report.js` writes JSON, Markdown, HTML, Mermaid and SVG artifacts.

## Craft Agents source mapping

| Craft Agents component | Lightweight replacement |
| --- | --- |
| `packages/pi-agent-server` | `src/pi-agent-adapter.js`, `src/pi-tools.js` |
| `packages/session-tools-core` | validated functions in `src/planner.js` |
| `packages/shared/src/prompts/system.ts` | `SYSTEM_PROMPT` in `src/pi-agent-adapter.js` |
| `transform_data` | `readDataFile`, `executePlan`, `writeReport` |
| datatable/spreadsheet/Mermaid UI | report HTML table, Mermaid source and SVG chart |

The desktop shell, coding tools, messaging gateways, browser tools, MCP source management, Craft document integrations and multi-session workflow are intentionally omitted.

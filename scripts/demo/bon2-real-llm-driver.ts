import { readFileSync } from 'node:fs';
import { LABEL, templateSummary, validateSummary, type FireFacts, type Flag } from '../../services/advisor/src/facts';
import { LlmClient, LlmError } from '../../services/advisor/src/llm';

// One real call to the free LLM with synthetic fire facts. The key comes from the env file and is never printed.
const ENV_FILE = process.env.ENV_FILE ?? '.env.local';
const line = readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('GROQ_API_KEY='));
const key = (process.env.ADVISOR_LLM_API_KEY ?? line?.split('=')[1] ?? '').trim().replace(/^["']|["']$/g, '');
if (!key) { console.error('no GROQ_API_KEY in the env file'); process.exit(2); }

const facts: FireFacts = { id: 'hz-demo', province: 'Kalimantan Barat', count: 14, satellites: ['N', 'N20', 'N21'], frp: 61.5, severity: 'SIAGA', earliest: '2026-11-16T05:30:00.000Z' };
const flag: Flag = { id: 'hz-demo', score: 6.1, growth: 9, reasons: ['pertumbuhan 9 titik panas dalam jendela waktu, jauh di atas kebakaran lain', 'tingkat naik ke SIAGA'] };
const model = process.env.ADVISOR_LLM_MODEL ?? 'openai/gpt-oss-20b';
const client = new LlmClient({ baseUrl: process.env.ADVISOR_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1', model, apiKey: key, timeoutMs: 15000, reasoningEffort: /gpt-oss/.test(model) ? 'low' : null });

(async () => {
  const started = Date.now();
  try {
    const raw = await client.summarize(facts, flag);
    const verdict = validateSummary(raw, facts, flag);
    console.log(`model: ${model}  latency: ${Date.now() - started} ms`);
    console.log(`answer : ${raw.trim()}`);
    console.log(`valid  : ${verdict.ok ? 'yes, would be stored as summary_source=llm' : `no (${verdict.why}), the template would be used`}`);
    console.log(`template fallback: ${templateSummary(facts, flag)}`);
    console.log(`label  : ${LABEL}`);
    process.exit(0);
  } catch (err) {
    const kind = err instanceof LlmError ? err.kind : 'unknown';
    console.log(`call failed after ${Date.now() - started} ms (${kind}: ${err instanceof Error ? err.message : String(err)}); the advisor would use the template`);
    process.exit(1);
  }
})();

import pino from 'pino';
import { loggerOptions } from '../../../shared-types/src/obs-lite';
import { InMemoryStorage } from '../test-support/contract-fakes/fakes/in-memory-storage';
import { Advisor } from './advisor';
import { loadConfig } from './config';
import { AnomalyDetector } from './detector';
import { LlmClient } from './llm';
import { CircuitBreaker, TokenBucket } from './resilience';
import { buildServer } from './server';
import { StorageAdvisoryStore, StorageEventSource } from './store';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino(loggerOptions('advisor'));
  // Interim backend until the real StorageClient is wired (it sits behind the contract interface).
  const storage = new InMemoryStorage();
  const store = new StorageAdvisoryStore(storage);
  const llm = config.llmApiKey
    ? new LlmClient({ baseUrl: config.ADVISOR_LLM_BASE_URL, model: config.ADVISOR_LLM_MODEL, apiKey: config.llmApiKey, reasoningEffort: /gpt-oss/.test(config.ADVISOR_LLM_MODEL) ? config.ADVISOR_LLM_REASONING_EFFORT || null : null, timeoutMs: config.ADVISOR_LLM_TIMEOUT_MS })
    : null;
  if (!llm) logger.warn({}, 'no LLM key: template-only mode (anomaly flags still work)');

  const advisor = new Advisor({
    source: new StorageEventSource(storage), store,
    detector: new AnomalyDetector({ windowMs: config.ADVISOR_WINDOW_MS, zThreshold: config.ADVISOR_Z_THRESHOLD, minGrowth: config.ADVISOR_MIN_GROWTH, minFires: config.ADVISOR_MIN_FIRES, frpFactor: config.ADVISOR_FRP_FACTOR, frpMinDelta: config.ADVISOR_FRP_MIN_DELTA_MW }),
    llm, model: llm ? config.ADVISOR_LLM_MODEL : null,
    breaker: new CircuitBreaker(config.ADVISOR_BREAKER_FAILURES, config.ADVISOR_BREAKER_COOLDOWN_MS),
    bucket: new TokenBucket(config.ADVISOR_LLM_RATE_PER_MIN), queueMax: config.ADVISOR_QUEUE_MAX, logger,
  });

  let ready = false;
  const app = buildServer({ metrics: advisor.metrics, store, internalKey: config.INTERNAL_SERVICE_KEY, isReady: () => ready, llmEnabled: llm !== null });
  await app.listen({ port: config.ADVISOR_PORT, host: '0.0.0.0' });

  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap ticks
    running = true;
    void advisor.tick().finally(() => { running = false; });
  }, config.ADVISOR_POLL_MS);
  timer.unref();

  const shutdown = async (): Promise<void> => { ready = false; clearInterval(timer); await app.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  ready = true;
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

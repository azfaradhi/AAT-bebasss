import { z } from 'zod';

const schema = z.object({
  AGGREGATOR_PORT: z.coerce.number().int().positive().default(8090),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  POLL_LOOKBACK_MS: z.coerce.number().int().nonnegative().default(60000),
  BMKG_BASE_URL: z.string().url().default('http://localhost:8081'),
  PVMBG_BASE_URL: z.string().url().default('http://localhost:8082'),
  BMKG_API_KEY: z.string().min(1),
  PVMBG_ACCESS_TOKEN: z.string().min(1),
  SOURCE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(10000),
  PVMBG_MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(5),
  DATABASE_URL: z.string().min(1).optional(),
  AUDIT_TOKEN: z.string().min(1).optional(),
  NOTIFIER_BASE_URL: z.string().url().optional(),
  PANTAI_BASE_URL: z.string().url().optional(),
  PANTAI_AUTH_TOKEN: z.string().min(1).optional(),
  PANTAI_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  PANTAI_TIMEOUT_MS: z.coerce.number().int().positive().default(2500),
  PANTAI_MAX_STALENESS_S: z.coerce.number().int().positive().default(3600),
  OUTBOX_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  STORAGE_REPAIR_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STORAGE_MEMBERSHIP_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RABBITMQ_URL: z.string().min(1),
  INTERNAL_SERVICE_KEY: z.string().min(1),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}

export const config = {
  port: parsed.data.AGGREGATOR_PORT,
  outboxDispatchIntervalMs: parsed.data.OUTBOX_DISPATCH_INTERVAL_MS,
  pollIntervalMs: parsed.data.POLL_INTERVAL_MS,
  pollLookbackMs: parsed.data.POLL_LOOKBACK_MS,
  bmkgBaseUrl: parsed.data.BMKG_BASE_URL,
  pvmbgBaseUrl: parsed.data.PVMBG_BASE_URL,
  bmkgApiKey: parsed.data.BMKG_API_KEY,
  pvmbgAccessToken: parsed.data.PVMBG_ACCESS_TOKEN,
  sourceRequestTimeoutMs: parsed.data.SOURCE_REQUEST_TIMEOUT_MS,
  circuitBreakerFailureThreshold: parsed.data.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  circuitBreakerCooldownMs: parsed.data.CIRCUIT_BREAKER_COOLDOWN_MS,
  pvmbgMaxConcurrentCalls: parsed.data.PVMBG_MAX_CONCURRENT_CALLS,
  databaseUrl: parsed.data.DATABASE_URL,
  auditToken: parsed.data.AUDIT_TOKEN,
  notifierBaseUrl: parsed.data.NOTIFIER_BASE_URL,
  pantaiBaseUrl: parsed.data.PANTAI_BASE_URL,
  pantaiAuthToken: parsed.data.PANTAI_AUTH_TOKEN,
  pantaiPollIntervalMs: parsed.data.PANTAI_POLL_INTERVAL_MS,
  pantaiTimeoutMs: parsed.data.PANTAI_TIMEOUT_MS,
  pantaiMaxStalenessS: parsed.data.PANTAI_MAX_STALENESS_S,
  storageRepairIntervalMs: parsed.data.STORAGE_REPAIR_INTERVAL_MS,
  storageMembershipIntervalMs: parsed.data.STORAGE_MEMBERSHIP_INTERVAL_MS,
  rabbitmqUrl: parsed.data.RABBITMQ_URL,
  internalServiceKey: parsed.data.INTERNAL_SERVICE_KEY,
};

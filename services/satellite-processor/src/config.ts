import { z } from 'zod';

const schema = z.object({
  SAT_FEED_BASE_URL: z.string().url(),
  SAT_GROUP_TOKEN: z.string().min(1),
  SAT_ALLOWED_LATENESS_MIN: z.coerce.number().int().nonnegative().default(360),
  SAT_CHECKPOINT_EVERY_N: z.coerce.number().int().positive().default(100),
  SAT_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  SAT_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SAT_RECONNECT_MIN_MS: z.coerce.number().int().nonnegative().default(200),
  SAT_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(15_000),
  SAT_SESSION_POLL_MS: z.coerce.number().int().positive().default(5_000),
  SATELLITE_PORT: z.coerce.number().int().positive().default(8095),
  POD_NAME: z.string().default('satellite-processor-local'),
});

export type SatelliteConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv): SatelliteConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

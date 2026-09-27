import { z } from 'zod';

const schema = z.object({
  AGGREGATOR_PORT: z.coerce.number().int().positive().default(8090),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}

export const config = {
  port: parsed.data.AGGREGATOR_PORT,
  pollIntervalMs: parsed.data.POLL_INTERVAL_MS,
};

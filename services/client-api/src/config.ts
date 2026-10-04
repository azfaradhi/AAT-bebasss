import { z } from 'zod';

const schema = z.object({
  CLIENT_API_PORT: z.coerce.number().int().positive().default(8080),
  CLIENT_JWT_SECRET: z.string().min(1),
  AGGREGATOR_BASE_URL: z.string().url().default('http://localhost:8090'),
  INTERNAL_SERVICE_KEY: z.string().min(1),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}

export const config = {
  port: parsed.data.CLIENT_API_PORT,
  clientJwtSecret: parsed.data.CLIENT_JWT_SECRET,
  aggregatorBaseUrl: parsed.data.AGGREGATOR_BASE_URL,
  internalServiceKey: parsed.data.INTERNAL_SERVICE_KEY,
};

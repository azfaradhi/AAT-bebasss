import { z } from 'zod';

const schema = z.object({
  CLIENT_API_PORT: z.coerce.number().int().positive().default(8080),
  CLIENT_JWT_SECRET: z.string().min(1),
  JWT_CLOCK_TOLERANCE_S: z.coerce.number().int().min(0).default(60),
  AGGREGATOR_BASE_URL: z.string().url().default('http://localhost:8090'),
  AGGREGATOR_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  INTERNAL_SERVICE_KEY: z.string().min(1),
  ADMISSION_MAX_INFLIGHT: z.coerce.number().int().min(1).default(64),
  ADMISSION_LAPANGAN_RESERVED: z.coerce.number().int().min(0).default(16),
  ADMISSION_MEDIA_MAX_INFLIGHT: z.coerce.number().int().min(1).default(24),
  ADMISSION_RETRY_AFTER_S: z.coerce.number().int().min(1).default(3),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}

export const config = {
  port: parsed.data.CLIENT_API_PORT,
  clientJwtSecret: parsed.data.CLIENT_JWT_SECRET,
  jwtClockToleranceSeconds: parsed.data.JWT_CLOCK_TOLERANCE_S,
  aggregatorBaseUrl: parsed.data.AGGREGATOR_BASE_URL,
  aggregatorRequestTimeoutMs: parsed.data.AGGREGATOR_REQUEST_TIMEOUT_MS,
  internalServiceKey: parsed.data.INTERNAL_SERVICE_KEY,
  admissionMaxInflight: parsed.data.ADMISSION_MAX_INFLIGHT,
  admissionLapanganReserved: parsed.data.ADMISSION_LAPANGAN_RESERVED,
  admissionMediaMaxInflight: parsed.data.ADMISSION_MEDIA_MAX_INFLIGHT,
  admissionRetryAfterSeconds: parsed.data.ADMISSION_RETRY_AFTER_S,
};

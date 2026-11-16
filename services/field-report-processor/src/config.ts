import { z } from 'zod';

const schema = z.object({
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  FIELD_REPORT_PORT: z.coerce.number().int().positive().default(8096),
  POD_NAME: z.string().default('field-report-processor-local'),
});

export type FieldReportConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv): FieldReportConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

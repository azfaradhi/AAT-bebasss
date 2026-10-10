import { z } from 'zod';

const schema = z
  .object({
    PVMBG_PORT: z.coerce.number().int().positive().default(8082),
    PVMBG_JWT_SECRET: z.string().min(1),
    PVMBG_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(500),
    PVMBG_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(3000),
  })
  .refine((c) => c.PVMBG_DELAY_MIN_MS <= c.PVMBG_DELAY_MAX_MS, {
    message: 'PVMBG_DELAY_MIN_MS must not exceed PVMBG_DELAY_MAX_MS',
  });

export type PvmbgConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv): PvmbgConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

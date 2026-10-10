import { z } from 'zod';

const schema = z
  .object({
    BMKG_PORT: z.coerce.number().int().positive().default(8081),
    BMKG_API_KEY: z.string().min(1),
    BMKG_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(50),
    BMKG_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(150),
  })
  .refine((c) => c.BMKG_DELAY_MIN_MS <= c.BMKG_DELAY_MAX_MS, {
    message: 'BMKG_DELAY_MIN_MS must not exceed BMKG_DELAY_MAX_MS',
  });

export type BmkgConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv): BmkgConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

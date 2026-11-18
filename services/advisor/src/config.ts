import { z } from 'zod';

const num = (def: number) => z.coerce.number().default(def);

const schema = z.object({
  ADVISOR_PORT: z.coerce.number().int().positive().default(8097),
  ADVISOR_POLL_MS: z.coerce.number().int().positive().default(30_000),
  ADVISOR_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  ADVISOR_Z_THRESHOLD: num(3.5),
  ADVISOR_MIN_GROWTH: num(3),
  ADVISOR_MIN_FIRES: z.coerce.number().int().positive().default(5),
  ADVISOR_FRP_FACTOR: num(1.5),
  ADVISOR_FRP_MIN_DELTA_MW: num(20),
  ADVISOR_LLM_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  ADVISOR_LLM_MODEL: z.string().default('openai/gpt-oss-20b'),
  ADVISOR_LLM_REASONING_EFFORT: z.string().default('low'), // sent only to reasoning models (gpt-oss); '' disables
  ADVISOR_LLM_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  ADVISOR_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  ADVISOR_LLM_RATE_PER_MIN: z.coerce.number().int().positive().default(20),
  ADVISOR_QUEUE_MAX: z.coerce.number().int().positive().default(100),
  ADVISOR_BREAKER_FAILURES: z.coerce.number().int().positive().default(5),
  ADVISOR_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),
  INTERNAL_SERVICE_KEY: z.string().default('dev-internal-key'),
  POD_NAME: z.string().default('advisor-local'),
});

export type AdvisorConfig = Omit<z.infer<typeof schema>, 'ADVISOR_LLM_API_KEY' | 'GROQ_API_KEY'> & { llmApiKey: string | null };

export function loadConfig(env: NodeJS.ProcessEnv): AdvisorConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const { ADVISOR_LLM_API_KEY, GROQ_API_KEY, ...rest } = parsed.data;
  const key = (ADVISOR_LLM_API_KEY ?? GROQ_API_KEY ?? '').trim();
  return { ...rest, llmApiKey: key.length > 0 ? key : null };
}

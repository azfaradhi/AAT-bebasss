import { z } from 'zod';

// Read once by the caller, not per message.
const schema = z.object({
  MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(262_144),
  MAX_JSON_DEPTH: z.coerce.number().int().positive().max(1000).default(32),
  PARK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
});

export interface IngestLimits { maxBytes: number; maxDepth: number; maxAttempts: number }

export function loadIngestLimits(env: Record<string, string | undefined> = process.env): IngestLimits {
  const p = schema.parse(env);
  return { maxBytes: p.MAX_MESSAGE_BYTES, maxDepth: p.MAX_JSON_DEPTH, maxAttempts: p.PARK_MAX_ATTEMPTS };
}

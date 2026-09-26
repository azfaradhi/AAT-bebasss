import { z } from 'zod';

const required = z.string().min(1);

const schema = z.object({
  AUTH_SERVICE_PORT: z.coerce.number().int().positive().default(8091),
  CLIENT_JWT_SECRET: required,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  AUTH_MEDIA_CLIENT_ID: required,
  AUTH_MEDIA_CLIENT_SECRET: required,
  AUTH_LAPANGAN_CLIENT_ID: required,
  AUTH_LAPANGAN_CLIENT_SECRET: required,
  AUTH_INTERNAL_CLIENT_ID: required,
  AUTH_INTERNAL_CLIENT_SECRET: required,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}
const env = parsed.data;

export const config = {
  port: env.AUTH_SERVICE_PORT,
  jwtSecret: env.CLIENT_JWT_SECRET,
  accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
  clients: [
    { clientId: env.AUTH_MEDIA_CLIENT_ID, clientSecret: env.AUTH_MEDIA_CLIENT_SECRET, scope: 'media' as const },
    { clientId: env.AUTH_LAPANGAN_CLIENT_ID, clientSecret: env.AUTH_LAPANGAN_CLIENT_SECRET, scope: 'lapangan' as const },
    { clientId: env.AUTH_INTERNAL_CLIENT_ID, clientSecret: env.AUTH_INTERNAL_CLIENT_SECRET, scope: 'internal' as const },
  ],
};

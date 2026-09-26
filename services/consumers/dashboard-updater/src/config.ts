import { z } from 'zod';

const schema = z.object({
  DASHBOARD_CONSUMER_PORT: z.coerce.number().int().positive().default(8092),
  RABBITMQ_URL: z.string().min(1),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}

export const config = {
  port: parsed.data.DASHBOARD_CONSUMER_PORT,
  rabbitmqUrl: parsed.data.RABBITMQ_URL,
};

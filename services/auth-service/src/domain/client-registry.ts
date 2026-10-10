import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClientScope } from '../../../../shared-types/src/auth';

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  scope: ClientScope;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export class ClientRegistry {
  constructor(private readonly clients: readonly RegisteredClient[]) {}

  findById(clientId: string): RegisteredClient | undefined {
    return this.clients.find((c) => safeEqual(c.clientId, clientId));
  }

  authenticate(clientId: string, clientSecret: string): RegisteredClient | undefined {
    const client = this.findById(clientId);
    const secretOk = safeEqual(client?.clientSecret ?? '\0unknown', clientSecret);
    return client && secretOk ? client : undefined;
  }
}

import pino from 'pino';
import { buildApp } from './app';
import { ClientRegistry } from './domain/clientRegistry';
import { TokenService } from './domain/tokenService';

export const TEST_SECRET = 'test-secret';

export const TEST_CLIENTS = [
  { clientId: 'media-client', clientSecret: 'media-secret', scope: 'media' as const },
  { clientId: 'lapangan-client', clientSecret: 'lapangan-secret', scope: 'lapangan' as const },
  { clientId: 'internal-client', clientSecret: 'internal-secret', scope: 'internal' as const },
];

export function buildTestApp(accessTtl = 60, refreshTtl = 900) {
  const tokens = new TokenService(TEST_SECRET, accessTtl, refreshTtl);
  const app = buildApp(pino({ level: 'silent' }), { registry: new ClientRegistry(TEST_CLIENTS), tokens });
  return { app, tokens };
}

import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-helpers';

const { app, tokens } = buildTestApp();

describe('POST /auth/token', () => {
  it.each([
    ['media-client', 'media-secret', 'media'],
    ['lapangan-client', 'lapangan-secret', 'lapangan'],
    ['internal-client', 'internal-secret', 'internal'],
  ])('issues a token pair for %s', async (client_id, client_secret, scope) => {
    const res = await app.inject({ method: 'POST', url: '/auth/token', payload: { client_id, client_secret } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(60);
    const access = tokens.verifyAccessToken(body.access_token);
    expect(access).toMatchObject({ sub: client_id, scope, aud: 'bnpb-client', purpose: 'access' });
    expect(tokens.verifyRefreshToken(body.refresh_token)).toMatchObject({ sub: client_id, scope, purpose: 'refresh' });
  });

  it('rejects a wrong secret with 401 INVALID_CREDENTIALS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { client_id: 'media-client', client_secret: 'lapangan-secret' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('gives the same 401 for an unknown client_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { client_id: 'ghost', client_secret: 'x' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a missing field with 400 ErrorEnvelope', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/token', payload: { client_id: 'media-client' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });
});

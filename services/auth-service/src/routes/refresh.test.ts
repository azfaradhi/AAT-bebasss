import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, TEST_SECRET } from '../test-helpers';

afterEach(() => vi.useRealTimers());

async function login(app: ReturnType<typeof buildTestApp>['app'], id = 'lapangan-client', secret = 'lapangan-secret') {
  const res = await app.inject({ method: 'POST', url: '/auth/token', payload: { client_id: id, client_secret: secret } });
  return res.json() as { access_token: string; refresh_token: string };
}

describe('POST /auth/refresh', () => {
  it('issues a new working pair without client credentials', async () => {
    const { app, tokens } = buildTestApp();
    const first = await login(app);
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: first.refresh_token } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token_type).toBe('Bearer');
    expect(tokens.verifyAccessToken(body.access_token)).toMatchObject({ sub: 'lapangan-client', scope: 'lapangan' });
    expect(tokens.verifyRefreshToken(body.refresh_token).sub).toBe('lapangan-client');
  });

  it('old access token expires by its own exp after the TTL, refresh still works', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, tokens } = buildTestApp(60, 900);
    const first = await login(app);

    vi.setSystemTime(Date.now() + 61_000);
    expect(() => tokens.verifyAccessToken(first.access_token)).toThrowError(/expired/i);

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: first.refresh_token } });
    expect(res.statusCode).toBe(200);
    expect(tokens.verifyAccessToken(res.json().access_token).sub).toBe('lapangan-client');
  });

  it('rejects an expired refresh token with 401 TOKEN_EXPIRED', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app } = buildTestApp(60, 900);
    const first = await login(app);
    vi.setSystemTime(Date.now() + 901_000);
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: first.refresh_token } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects an access token used as a refresh token', async () => {
    const { app } = buildTestApp();
    const first = await login(app);
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: first.access_token } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a token signed with another secret, or for another audience', async () => {
    const { app } = buildTestApp();
    const forged = jwt.sign({ scope: 'internal', purpose: 'refresh' }, 'some-other-secret', {
      subject: 'internal-client', audience: 'bnpb-client', expiresIn: 900,
    });
    const wrongAud = jwt.sign({ scope: 'internal', purpose: 'refresh' }, TEST_SECRET, {
      subject: 'internal-client', audience: 'pvmbg', expiresIn: 900,
    });
    for (const refresh_token of [forged, wrongAud, 'garbage']) {
      const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token } });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_TOKEN');
    }
  });

  it('rejects a token whose scope does not match the provisioned client', async () => {
    const { app } = buildTestApp();
    const escalated = jwt.sign({ scope: 'internal', purpose: 'refresh' }, TEST_SECRET, {
      subject: 'media-client', audience: 'bnpb-client', expiresIn: 900,
    });
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: escalated } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing body field with 400', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

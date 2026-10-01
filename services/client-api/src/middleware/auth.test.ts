import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { createAuthMiddleware } from './auth';
import { signAccessToken, TEST_SECRET } from '../test-helpers';

function app() {
  const a = Fastify({ logger: false });
  a.addHook('preHandler', createAuthMiddleware(TEST_SECRET));
  a.get('/protected', async (request) => ({ scope: request.clientScope, clientId: request.clientId }));
  return a;
}

describe('requireClientAuth', () => {
  it('attaches scope and clientId from a valid token', async () => {
    const token = signAccessToken('lapangan');
    const res = await app().inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scope: 'lapangan', clientId: 'lapangan-client' });
  });

  it('rejects a missing Authorization header with 401', async () => {
    const res = await app().inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a non-Bearer header with 401', async () => {
    const res = await app().inject({ method: 'GET', url: '/protected', headers: { authorization: 'Basic xyz' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = signAccessToken('media', {}, 'some-other-secret');
    const res = await app().inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token for the wrong audience', async () => {
    const token = jwt.sign({ scope: 'media', purpose: 'access' }, TEST_SECRET, { subject: 'media-client', audience: 'other-aud', expiresIn: '60s' });
    const res = await app().inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired token with 401', async () => {
    const token = jwt.sign({ scope: 'media', purpose: 'access' }, TEST_SECRET, { subject: 'media-client', audience: 'bnpb-client', expiresIn: -1 });
    const res = await app().inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a refresh token presented as an access token', async () => {
    const token = jwt.sign({ scope: 'media', purpose: 'refresh' }, TEST_SECRET, { subject: 'media-client', audience: 'bnpb-client', expiresIn: '900s' });
    const res = await app().inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects garbage tokens', async () => {
    const res = await app().inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer not-a-jwt' } });
    expect(res.statusCode).toBe(401);
  });
});

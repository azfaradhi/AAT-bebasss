#!/usr/bin/env node
// Mints a PVMBG JWT for local dev (HS256, aud: 'pvmbg'), no dependencies.
// Usage: node scripts/mint-pvmbg-token.js [expirySeconds]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readEnvFile(key) {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return undefined;
  const line = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mintToken(secret, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: 'pvmbg', iat: now, exp: now + expiresInSeconds };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

const secret = process.env.PVMBG_JWT_SECRET || readEnvFile('PVMBG_JWT_SECRET');
if (!secret) {
  throw new Error('PVMBG_JWT_SECRET must be set in the environment or .env');
}
const expiresInSeconds = Number(process.argv[2]) || 10 * 365 * 24 * 3600; // default: ~10 years
console.log(mintToken(secret, expiresInSeconds));

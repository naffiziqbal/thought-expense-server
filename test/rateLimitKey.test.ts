import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { rateLimitKey } from '../src/middleware/rateLimit';

function reqWithBearer(token: string, ip = '203.0.113.10'): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    ip,
  } as Request;
}

describe('rateLimitKey', () => {
  const secret = () => process.env.JWT_SECRET as string;

  it('keys verified access tokens by user id', () => {
    const token = jwt.sign({ id: 'user-abc', purpose: 'access' }, secret(), { expiresIn: '7d' });
    expect(rateLimitKey(reqWithBearer(token))).toBe('user:user-abc');
  });

  it('falls back to IP for a forged payload (wrong secret)', () => {
    const token = jwt.sign({ id: 'victim-id', purpose: 'access' }, 'not-the-server-secret', {
      expiresIn: '7d',
    });
    expect(rateLimitKey(reqWithBearer(token, '198.51.100.2'))).toBe('ip:198.51.100.2');
  });

  it('falls back to IP for an unsigned header.payload blob', () => {
    const payload = Buffer.from(JSON.stringify({ id: 'victim-id' })).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(rateLimitKey(reqWithBearer(`${header}.${payload}.`, '198.51.100.3'))).toBe(
      'ip:198.51.100.3'
    );
  });

  it('falls back to IP for a password-reset JWT', () => {
    const token = jwt.sign(
      { id: 'user-abc', email: 'a@example.com', purpose: 'password_reset' },
      secret(),
      { expiresIn: '1h' }
    );
    expect(rateLimitKey(reqWithBearer(token, '198.51.100.4'))).toBe('ip:198.51.100.4');
  });
});

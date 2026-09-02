import { healthResponseSchema, type ClientInput } from '@69-seconds/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AuthService } from './auth/service.js';

function testApp() {
  return createApp({
    config: {
      webOrigins: ['http://localhost:5173'],
      trustProxy: false,
      cookie: { name: '69s_session', secure: false, sameSite: 'lax', ttlMs: 60_000 },
      authRateLimit: { windowMs: 60_000, limit: 100 },
    },
    // These requests are rejected before an auth service method is needed.
    auth: {} as AuthService,
  });
}

describe('server workspace shared-contract consumption', () => {
  it('consumes the shared health contract', () => {
    const response = healthResponseSchema.parse({ status: 'ok', service: '69-seconds-server' });
    expect(response.status).toBe('ok');
  });

  it('can type a future simulation input with the shared contract', () => {
    const input: ClientInput = {
      sequence: 1,
      clientTimeMs: 100,
      movement: { up: true, down: false, left: false, right: false },
      sprint: false,
    };
    expect(input.movement.up).toBe(true);
  });

  it('rejects cross-site credential mutations and prevents auth responses from being cached', async () => {
    const crossSite = await request(testApp())
      .post('/api/auth/logout')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({})
      .expect(403);
    expect(crossSite.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(crossSite.headers['cache-control']).toBe('no-store');
  });

  it('returns a typed 413 instead of a 500 for an oversized JSON body', async () => {
    const response = await request(testApp())
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ identifier: 'player@example.com', password: 'x'.repeat(20_000) })
      .expect(413);
    expect(response.body).toMatchObject({ error: { code: 'INVALID_PAYLOAD' } });
  });
});

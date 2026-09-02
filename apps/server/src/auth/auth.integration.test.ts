import { migrate } from 'drizzle-orm/mysql2/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDatabase, type DatabaseConnection } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { AuthService } from './service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const cookieConfig = {
  name: '69s_session',
  secure: false,
  sameSite: 'lax' as const,
  ttlMs: 60_000,
};

function cookieFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  if (!first) throw new Error('Expected Set-Cookie header');
  return first.split(';')[0]!;
}

describeWithDatabase('authentication HTTP integration', () => {
  let connection: DatabaseConnection;
  let now = new Date('2026-09-02T00:00:00.000Z');
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!url.pathname.toLowerCase().includes('test')) {
      throw new Error('TEST_DATABASE_URL must name a database containing "test"');
    }
    connection = createDatabase(databaseUrl!);
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    });
    const auth = new AuthService(connection.db, cookieConfig.ttlMs, () => now);
    app = createApp({
      auth,
      config: {
        webOrigins: ['http://localhost:5173'],
        trustProxy: false,
        cookie: cookieConfig,
        authRateLimit: { windowMs: 60_000, limit: 1_000 },
      },
    });
  });

  beforeEach(async () => {
    now = new Date('2026-09-02T00:00:00.000Z');
    await connection.db.delete(sessions);
    await connection.db.delete(users);
  });

  afterAll(async () => {
    await connection?.pool.end();
  });

  it('registers, normalizes email, stores an Argon2id hash, and returns a safe user', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: '  PLAYER@Example.COM ', password: 'correct-horse-battery' })
      .expect(201);

    expect(response.body).toMatchObject({ user: { email: 'player@example.com' } });
    expect(JSON.stringify(response.body)).not.toMatch(/password|session|token|hash/i);
    const setCookie = response.headers['set-cookie'] as unknown as string[];
    expect(setCookie[0]).toContain('HttpOnly');
    expect(setCookie[0]).toContain('SameSite=Lax');
    expect(setCookie[0]).not.toContain('Secure');

    const stored = await connection.db.select().from(users);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.email).toBe('player@example.com');
    expect(stored[0]?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored[0]?.passwordHash).not.toContain('correct-horse-battery');
  });

  it('rejects duplicate normalized email addresses with a stable code', async () => {
    await request(app).post('/api/auth/register')
      .send({ email: 'player@example.com', password: 'correct-horse-battery' }).expect(201);
    const response = await request(app).post('/api/auth/register')
      .send({ email: ' PLAYER@example.com ', password: 'another-long-password' }).expect(409);
    expect(response.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rejects invalid credentials without revealing which credential failed', async () => {
    await request(app).post('/api/auth/register')
      .send({ email: 'player@example.com', password: 'correct-horse-battery' }).expect(201);

    const wrongPassword = await request(app).post('/api/auth/login')
      .send({ email: 'player@example.com', password: 'definitely-not-right' }).expect(401);
    const missingUser = await request(app).post('/api/auth/login')
      .send({ email: 'missing@example.com', password: 'definitely-not-right' }).expect(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(missingUser.body.error).toEqual(wrongPassword.body.error);
  });

  it('logs in and replaces the presented session', async () => {
    const agent = request.agent(app);
    const registration = await agent.post('/api/auth/register')
      .send({ email: 'player@example.com', password: 'correct-horse-battery' }).expect(201);
    const originalCookie = cookieFrom(registration);

    const login = await agent.post('/api/auth/login')
      .send({ email: 'PLAYER@EXAMPLE.COM', password: 'correct-horse-battery' }).expect(200);
    const replacementCookie = cookieFrom(login);
    expect(replacementCookie).not.toBe(originalCookie);

    await request(app).get('/api/auth/me').set('Cookie', originalCookie).expect(401);
    const current = await request(app).get('/api/auth/me').set('Cookie', replacementCookie).expect(200);
    expect(current.body.user.email).toBe('player@example.com');
    expect(await connection.db.select().from(sessions)).toHaveLength(1);
  });

  it('logs out idempotently and revokes the current session', async () => {
    const registration = await request(app).post('/api/auth/register')
      .send({ email: 'player@example.com', password: 'correct-horse-battery' }).expect(201);
    const cookie = cookieFrom(registration);

    const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(200);
    expect(logout.body).toEqual({ success: true });
    expect(logout.headers['set-cookie']?.[0]).toContain('69s_session=;');
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
    expect(await connection.db.select().from(sessions)).toHaveLength(0);
    await request(app).post('/api/auth/logout').expect(200);
  });

  it('rejects expired sessions and protects current-user routes', async () => {
    await request(app).get('/api/auth/me').expect(401);
    const registration = await request(app).post('/api/auth/register')
      .send({ email: 'player@example.com', password: 'correct-horse-battery' }).expect(201);
    const cookie = cookieFrom(registration);
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);

    now = new Date(now.getTime() + cookieConfig.ttlMs + 1);
    const expired = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
    expect(expired.body.error.code).toBe('UNAUTHENTICATED');
    expect(expired.headers['set-cookie']?.[0]).toContain('69s_session=;');
  });

  it('validates request bodies and rate-limits credential endpoints', async () => {
    const malformed = await request(app).post('/api/auth/register')
      .set('Content-Type', 'application/json').send('{').expect(400);
    expect(malformed.body.error.code).toBe('INVALID_PAYLOAD');
    const unexpectedLogoutBody = await request(app).post('/api/auth/logout')
      .send({ session: 'client-supplied-secret' }).expect(400);
    expect(unexpectedLogoutBody.body.error.code).toBe('INVALID_PAYLOAD');

    const limitedAuth = new AuthService(connection.db, cookieConfig.ttlMs, () => now);
    const limitedApp = createApp({
      auth: limitedAuth,
      config: {
        webOrigins: ['http://localhost:5173'],
        trustProxy: false,
        cookie: cookieConfig,
        authRateLimit: { windowMs: 60_000, limit: 1 },
      },
    });
    await request(limitedApp).post('/api/auth/login')
      .send({ email: 'missing@example.com', password: 'bad' }).expect(401);
    const limited = await request(limitedApp).post('/api/auth/login')
      .send({ email: 'missing@example.com', password: 'bad' }).expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});

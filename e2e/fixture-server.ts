/**
 * Browser-test server: production HTTP routes and production Socket.IO room/game
 * code, with only the MySQL-backed auth persistence replaced by an in-memory
 * implementation. Database behavior remains covered by the MySQL integration suite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { CreatedSession, AuthService } from '../apps/server/src/auth/service.js';
import { createApp } from '../apps/server/src/app.js';
import type { UserRow } from '../apps/server/src/db/schema.js';
import { attachSocketServer } from '../apps/server/src/socket.js';

const serverPort = 3101;
const webOrigin = 'http://127.0.0.1:4173';
const cookie = {
  name: '69s_e2e_session',
  secure: false,
  sameSite: 'lax' as const,
  ttlMs: 10 * 60_000,
};

class FixtureAuth {
  private readonly users = new Map<string, UserRow>();
  private readonly passwords = new Map<string, string>();
  private readonly sessions = new Map<string, { userId: string; expiresAt: Date }>();

  async register(username: string, email: string, password: string) {
    const now = new Date();
    const user: UserRow = {
      id: randomUUID(),
      username,
      email,
      passwordHash: 'e2e-only',
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    this.passwords.set(user.id, password);
    return { user, session: this.createSession(user.id) };
  }

  async login(identifier: string, password: string, currentToken?: string) {
    const user = [...this.users.values()].find(
      (candidate) => candidate.username === identifier || candidate.email === identifier,
    );
    if (!user || this.passwords.get(user.id) !== password) return null;
    if (currentToken) this.sessions.delete(currentToken);
    return { user, session: this.createSession(user.id) };
  }

  async resolveSession(token: string): Promise<UserRow | null> {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    return this.users.get(session.userId) ?? null;
  }

  async revokeSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  private createSession(userId: string): CreatedSession {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + cookie.ttlMs);
    this.sessions.set(token, { userId, expiresAt });
    return { token, expiresAt };
  }
}

const fixtureAuth = new FixtureAuth();
// AuthService is intentionally kept as the production boundary; this cast is
// localized because its private database field makes structural test doubles nominal.
const auth = fixtureAuth as unknown as AuthService;
const app = createApp({
  config: {
    webOrigins: [webOrigin],
    trustProxy: false,
    cookie,
    authRateLimit: { windowMs: 60_000, limit: 1_000 },
  },
  auth,
});
const httpServer = createServer(app);
const sockets = attachSocketServer(httpServer, {
  webOrigins: [webOrigin],
  auth,
  cookie,
  rooms: { countdownDurationMs: 100 },
});

httpServer.listen(serverPort, '127.0.0.1', () => {
  console.log(`E2E fixture listening on http://127.0.0.1:${serverPort}`);
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await sockets.close();
}

process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

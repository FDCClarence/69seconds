import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { sessions, users, type UserRow } from '../db/schema.js';

const PASSWORD_HASH_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

// A valid Argon2id hash is used when an email is absent to reduce account-enumeration timing differences.
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$NH3wdKIDAFkXqg/ju87+0w$4OQ87+PWgOnt2uB1U6upyGXo/73jldokn7be4dS3Ncg';

export class DuplicateEmailError extends Error {}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessionTtlMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async register(email: string, password: string): Promise<{ user: UserRow; session: CreatedSession }> {
    const passwordHash = await hash(password, PASSWORD_HASH_OPTIONS);

    try {
      return await this.db.transaction(async (transaction) => {
        // MySQL has no INSERT ... RETURNING, so the id is generated here and the row is read back.
        const id = randomUUID();
        await transaction.insert(users).values({ id, email, passwordHash });
        const user = await transaction.query.users.findFirst({ where: eq(users.id, id) });
        if (!user) throw new Error('User insert returned no row');
        const session = await this.createSession(user.id, transaction);
        return { user, session };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateEmailError();
      throw error;
    }
  }

  async login(email: string, password: string, currentToken?: string): Promise<{ user: UserRow; session: CreatedSession } | null> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    const passwordMatches = await verify(user?.passwordHash ?? DUMMY_PASSWORD_HASH, password).catch(() => false);
    if (!user || !passwordMatches) return null;

    const result = await this.db.transaction(async (transaction) => {
      if (currentToken) {
        await transaction.delete(sessions).where(eq(sessions.tokenHash, digestToken(currentToken)));
      }
      const session = await this.createSession(user.id, transaction);
      return { user, session };
    });
    return result;
  }

  async resolveSession(token: string): Promise<UserRow | null> {
    const result = await this.db.select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(
        eq(sessions.tokenHash, digestToken(token)),
        gt(sessions.expiresAt, this.now()),
      ))
      .limit(1);
    return result[0]?.user ?? null;
  }

  async revokeSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, digestToken(token)));
  }

  private async createSession(
    userId: string,
    database: Pick<Database, 'insert'> = this.db,
  ): Promise<CreatedSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs);
    await database.insert(sessions).values({
      tokenHash: digestToken(token),
      userId,
      expiresAt,
    });
    return { token, expiresAt };
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    cause?: { code?: unknown; errno?: unknown };
  };
  // MySQL reports a duplicate key as ER_DUP_ENTRY (errno 1062).
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062
    || candidate.cause?.code === 'ER_DUP_ENTRY' || candidate.cause?.errno === 1062;
}

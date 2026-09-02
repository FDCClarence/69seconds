import 'dotenv/config';
import type { SessionCookieConfig } from './auth/cookies.js';

export interface ServerConfig {
  port: number;
  webOrigins: string[];
  databaseUrl: string;
  trustProxy: false | number;
  cookie: SessionCookieConfig;
  authRateLimit: { windowMs: number; limit: number };
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseOrigins(value: string | undefined): string[] {
  const origins = (value ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0 || origins.some((origin) => origin === '*')) {
    throw new Error('WEB_ORIGIN must contain one or more explicit origins and cannot be *');
  }
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('WEB_ORIGIN entries must be exact HTTP(S) origins without paths');
    }
  }
  return origins;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (!['development', 'test', 'production'].includes(nodeEnv)) {
  throw new Error('NODE_ENV must be development, test, or production');
}

const secureCookie = nodeEnv === 'production';
const sameSite = process.env.COOKIE_SAME_SITE ?? 'lax';
if (!['lax', 'strict', 'none'].includes(sameSite)) {
  throw new Error('COOKIE_SAME_SITE must be lax, strict, or none');
}
if (sameSite === 'none' && !secureCookie) {
  throw new Error('COOKIE_SAME_SITE=none requires production Secure cookies');
}

const trustProxy = parseInteger(
  'TRUST_PROXY_HOPS',
  process.env.TRUST_PROXY_HOPS,
  nodeEnv === 'production' ? 1 : 0,
  0,
);

export const config: ServerConfig = {
  port: parseInteger('PORT', process.env.PORT, 3001, 1, 65_535),
  webOrigins: parseOrigins(process.env.WEB_ORIGIN),
  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),
  trustProxy: trustProxy === 0 ? false : trustProxy,
  cookie: {
    name: process.env.SESSION_COOKIE_NAME ?? (secureCookie ? '__Host-69s_session' : '69s_session'),
    secure: secureCookie,
    sameSite: sameSite as SessionCookieConfig['sameSite'],
    ttlMs: parseInteger('SESSION_TTL_MS', process.env.SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000, 60_000),
  },
  authRateLimit: {
    windowMs: parseInteger('AUTH_RATE_LIMIT_WINDOW_MS', process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, 1000),
    limit: parseInteger('AUTH_RATE_LIMIT_MAX', process.env.AUTH_RATE_LIMIT_MAX, 10, 1),
  },
};

import type { CookieOptions, Request, Response } from 'express';

export interface SessionCookieConfig {
  name: string;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  ttlMs: number;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookie values at this untrusted boundary.
    }
  }
  return cookies;
}

function baseCookieOptions(config: SessionCookieConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    path: '/',
  };
}

export function readSessionToken(request: Request, config: SessionCookieConfig): string | undefined {
  return parseCookies(request.headers.cookie).get(config.name);
}

export function setSessionCookie(
  response: Response,
  config: SessionCookieConfig,
  token: string,
): void {
  response.cookie(config.name, token, {
    ...baseCookieOptions(config),
    maxAge: config.ttlMs,
  });
}

export function clearSessionCookie(response: Response, config: SessionCookieConfig): void {
  response.clearCookie(config.name, baseCookieOptions(config));
}

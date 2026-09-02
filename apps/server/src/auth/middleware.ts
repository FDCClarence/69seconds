import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { clearSessionCookie, readSessionToken, type SessionCookieConfig } from './cookies.js';
import type { AuthService } from './service.js';
import type { UserRow } from '../db/schema.js';
import { sendApiError } from '../http.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: { user: UserRow; sessionToken: string };
  }
}

export function requireAuth(auth: AuthService, cookie: SessionCookieConfig): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const token = readSessionToken(request, cookie);
    if (!token) {
      sendApiError(response, 401, 'UNAUTHENTICATED', 'Authentication is required');
      return;
    }

    try {
      const user = await auth.resolveSession(token);
      if (!user) {
        clearSessionCookie(response, cookie);
        sendApiError(response, 401, 'UNAUTHENTICATED', 'Authentication is required');
        return;
      }
      request.auth = { user, sessionToken: token };
      next();
    } catch (error) {
      next(error);
    }
  };
}

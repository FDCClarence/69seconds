import {
  authResponseSchema,
  currentUserResponseSchema,
  loginRequestSchema,
  logoutRequestSchema,
  logoutResponseSchema,
  registerRequestSchema,
} from '@69-seconds/shared';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { clearSessionCookie, readSessionToken, setSessionCookie, type SessionCookieConfig } from './cookies.js';
import { requireAuth } from './middleware.js';
import { DuplicateEmailError, type AuthService } from './service.js';
import { sendApiError, toPublicUser } from '../http.js';

export interface AuthRouterOptions {
  auth: AuthService;
  cookie: SessionCookieConfig;
  rateLimit: { windowMs: number; limit: number };
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  const credentialRateLimit = rateLimit({
    windowMs: options.rateLimit.windowMs,
    limit: options.rateLimit.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_request, response) => {
      sendApiError(response, 429, 'RATE_LIMITED', 'Too many authentication attempts', true);
    },
  });

  router.post('/register', credentialRateLimit, asyncHandler(async (request, response) => {
    const parsed = registerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, 400, 'INVALID_PAYLOAD', 'Invalid registration request');
      return;
    }

    try {
      const result = await options.auth.register(parsed.data.email, parsed.data.password);
      setSessionCookie(response, options.cookie, result.session.token);
      response.status(201).json(authResponseSchema.parse({ user: toPublicUser(result.user) }));
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        sendApiError(response, 409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
        return;
      }
      throw error;
    }
  }));

  router.post('/login', credentialRateLimit, asyncHandler(async (request, response) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, 400, 'INVALID_PAYLOAD', 'Invalid login request');
      return;
    }

    const currentToken = readSessionToken(request, options.cookie);
    const result = await options.auth.login(parsed.data.email, parsed.data.password, currentToken);
    if (!result) {
      sendApiError(response, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      return;
    }
    setSessionCookie(response, options.cookie, result.session.token);
    response.json(authResponseSchema.parse({ user: toPublicUser(result.user) }));
  }));

  router.post('/logout', asyncHandler(async (request, response) => {
    if (!logoutRequestSchema.safeParse(request.body ?? {}).success) {
      sendApiError(response, 400, 'INVALID_PAYLOAD', 'Invalid logout request');
      return;
    }
    const token = readSessionToken(request, options.cookie);
    if (token) await options.auth.revokeSession(token);
    clearSessionCookie(response, options.cookie);
    response.json(logoutResponseSchema.parse({ success: true }));
  }));

  router.get('/me', requireAuth(options.auth, options.cookie), (request, response) => {
    response.json(currentUserResponseSchema.parse({ user: toPublicUser(request.auth!.user) }));
  });

  return router;
}

function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
}

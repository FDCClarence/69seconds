import { healthResponseSchema } from '@69-seconds/shared';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { createAuthRouter } from './auth/routes.js';
import type { AuthService } from './auth/service.js';
import type { ServerConfig } from './config.js';
import { sendApiError } from './http.js';

export interface AppOptions {
  config: Pick<ServerConfig, 'webOrigins' | 'trustProxy' | 'cookie' | 'authRateLimit'>;
  auth: AuthService;
}

export function createApp(options: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.config.trustProxy);
  app.use(cors({ origin: options.config.webOrigins, credentials: true }));
  app.use(express.json({ limit: '16kb', type: 'application/json' }));

  app.get('/api/health', (_request, response) => {
    const body = healthResponseSchema.parse({ status: 'ok', service: '69-seconds-server' });
    response.json(body);
  });

  app.use('/api/auth', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.get('origin');
      const fetchSite = request.get('sec-fetch-site');
      if ((origin && !options.config.webOrigins.includes(origin)) || fetchSite === 'cross-site') {
        sendApiError(response, 403, 'FORBIDDEN', 'Request origin is not allowed');
        return;
      }
    }
    next();
  }, createAuthRouter({
    auth: options.auth,
    cookie: options.config.cookie,
    rateLimit: options.config.authRateLimit,
  }));

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    void _next;
    if (error instanceof SyntaxError && 'body' in error) {
      sendApiError(response, 400, 'INVALID_PAYLOAD', 'Request body must be valid JSON');
      return;
    }
    if (isPayloadTooLarge(error)) {
      sendApiError(response, 413, 'INVALID_PAYLOAD', 'Request body is too large');
      return;
    }
    console.error(error);
    sendApiError(response, 500, 'INTERNAL_ERROR', 'An unexpected error occurred', true);
  };
  app.use(errorHandler);

  return app;
}

function isPayloadTooLarge(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; type?: unknown };
  return candidate.status === 413 || candidate.type === 'entity.too.large';
}

import { healthResponseSchema } from '@69-seconds/shared';
import cors from 'cors';
import express from 'express';

export function createApp(webOrigin: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: webOrigin, credentials: true }));
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_request, response) => {
    const body = healthResponseSchema.parse({ status: 'ok', service: '69-seconds-server' });
    response.json(body);
  });

  return app;
}

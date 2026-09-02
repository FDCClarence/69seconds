import {
  apiErrorResponseSchema,
  type PublicUser,
  type ServerErrorCode,
} from '@69-seconds/shared';
import type { Response } from 'express';
import type { UserRow } from './db/schema.js';

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}

export function sendApiError(
  response: Response,
  status: number,
  code: ServerErrorCode,
  message: string,
  retryable = false,
): void {
  response.status(status).json(apiErrorResponseSchema.parse({
    error: { code, message, retryable },
  }));
}

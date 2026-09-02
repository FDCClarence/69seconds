import {
  apiErrorResponseSchema,
  authResponseSchema,
  currentUserResponseSchema,
  logoutResponseSchema,
  type LoginRequest,
  type PublicUser,
  type RegisterRequest,
  type ServerErrorCode,
} from '@69-seconds/shared';

export class ApiError extends Error {
  constructor(readonly code: ServerErrorCode, readonly retryable: boolean, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface AuthApi {
  currentUser(): Promise<PublicUser | null>;
  login(input: LoginRequest): Promise<PublicUser>;
  register(input: RegisterRequest): Promise<PublicUser>;
  logout(): Promise<void>;
}

function apiBaseUrl(): string {
  return (import.meta.env.VITE_SERVER_URL ?? '').replace(/\/$/, '');
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = apiErrorResponseSchema.safeParse(body);
  if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.retryable, parsed.data.error.message);
  throw new Error(`Request failed with status ${response.status}`);
}

export const authApi: AuthApi = {
  async currentUser() {
    try {
      const response = await request('/api/auth/me');
      return currentUserResponseSchema.parse(await response.json()).user;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') return null;
      throw error;
    }
  },
  async login(input) {
    const response = await request('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
    return authResponseSchema.parse(await response.json()).user;
  },
  async register(input) {
    const response = await request('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
    return authResponseSchema.parse(await response.json()).user;
  },
  async logout() {
    const response = await request('/api/auth/logout', { method: 'POST', body: '{}' });
    logoutResponseSchema.parse(await response.json());
  },
};

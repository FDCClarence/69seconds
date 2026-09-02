import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { ApiError, type AuthApi } from './api.js';

const player = {
  id: '477aa564-8b3f-4fa0-bf2c-c523add8d9ce',
  email: 'player@example.com',
  createdAt: '2026-09-02T00:00:00.000Z',
};

function apiStub(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    currentUser: vi.fn().mockResolvedValue(null),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderAt(path: string, api: AuthApi) {
  window.history.replaceState({}, '', path);
  return render(<App api={api} />);
}

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('authentication application', () => {
  it('restores a current-user session into the protected home screen', async () => {
    const api = apiStub({ currentUser: vi.fn().mockResolvedValue(player) });
    renderAt('/home', api);
    expect(await screen.findByRole('heading', { name: 'Ready when your crew is.' })).toBeTruthy();
    expect(api.currentUser).toHaveBeenCalledOnce();
    expect(screen.getByText('player@example.com')).toBeTruthy();
  });

  it('sends unauthenticated visitors away from the home screen', async () => {
    renderAt('/home', apiStub());
    await userEvent.click(await screen.findByRole('button', { name: 'Go to login' }));
    expect(await screen.findByRole('heading', { name: 'Log in to play' })).toBeTruthy();
  });

  it('validates registration inline and completes the registration flow', async () => {
    const register = vi.fn().mockResolvedValue(player);
    renderAt('/register', apiStub({ register }));
    await screen.findByRole('heading', { name: 'Create your player pass' });
    await userEvent.click(screen.getByRole('button', { name: 'Create player pass' }));
    expect(screen.getByText('Enter your email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Email address'), 'player@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create player pass' }));
    await waitFor(() => expect(register).toHaveBeenCalledWith({ email: 'player@example.com', password: 'correct-horse-battery' }));
    expect((await screen.findByRole('status')).textContent).toContain('Player pass created');
  });

  it('presents a stable server error for a failed login', async () => {
    renderAt('/login', apiStub({ login: vi.fn().mockRejectedValue(new ApiError('INVALID_CREDENTIALS', false, 'Nope')) }));
    await screen.findByRole('heading', { name: 'Log in to play' });
    await userEvent.type(screen.getByLabelText('Email address'), 'player@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'not-the-right-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Log in' }).closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain('Email or password is incorrect.');
  });

  it('logs out from the authenticated home screen', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    renderAt('/home', apiStub({ currentUser: vi.fn().mockResolvedValue(player), logout }));
    await screen.findByRole('heading', { name: 'Ready when your crew is.' });
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(await screen.findByRole('heading', { name: /seconds to make it count/i })).toBeTruthy();
  });
});

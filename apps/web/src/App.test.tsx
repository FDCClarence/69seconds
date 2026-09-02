import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { ApiError, type AuthApi } from './api.js';
import type { RoomPublicState } from '@69-seconds/shared';
import type { RoomClient } from './room-client.js';

const player = {
  id: '477aa564-8b3f-4fa0-bf2c-c523add8d9ce',
  email: 'player@example.com',
  createdAt: '2026-09-02T00:00:00.000Z',
};

const lobby: RoomPublicState = {
  code: 'ABC234',
  phase: 'LOBBY',
  hostPlayerId: player.id,
  players: [{
    id: player.id,
    displayName: 'player',
    slot: 0,
    isHost: true,
    isReady: false,
    isConnected: true,
    connectionState: 'CONNECTED',
    position: { x: 0, y: 0 },
    carriedItemIds: [],
    depositedItemIds: [],
  }],
  serverTimeMs: 1_000,
  phaseEndsAtMs: null,
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

function roomClientStub(overrides: Partial<RoomClient> = {}): RoomClient {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn((listeners) => {
      listeners.onConnection('CONNECTED');
      return () => undefined;
    }),
    createRoom: vi.fn().mockResolvedValue(lobby),
    joinRoom: vi.fn().mockResolvedValue(lobby),
    leaveRoom: vi.fn().mockResolvedValue(null),
    setReady: vi.fn().mockResolvedValue(lobby),
    startMatch: vi.fn().mockResolvedValue(lobby),
    ...overrides,
  };
}

function renderAt(path: string, api: AuthApi, rooms: RoomClient = roomClientStub()) {
  window.history.replaceState({}, '', path);
  return render(<App api={api} roomClient={rooms} />);
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

  it('creates a private room and renders authoritative lobby status', async () => {
    const rooms = roomClientStub();
    renderAt('/home', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms);
    await userEvent.click(await screen.findByRole('button', { name: /create room/i }));
    expect(await screen.findByRole('heading', { name: 'Create a room.' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Generate room code' }));
    expect(await screen.findByRole('heading', { name: 'Crew at the carts.' })).toBeTruthy();
    expect(screen.getByText('ABC234')).toBeTruthy();
    expect(screen.getByText('Host')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(rooms.createRoom).toHaveBeenCalledOnce();
  });

  it('validates join codes before sending a join command', async () => {
    const rooms = roomClientStub();
    renderAt('/room/join', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms);
    const code = await screen.findByLabelText('Room code');
    await userEvent.type(code, 'OOPS');
    await userEvent.click(screen.getByRole('button', { name: 'Join room' }));
    expect((await screen.findByRole('alert')).textContent).toContain('six-character room code');
    expect(rooms.joinRoom).not.toHaveBeenCalled();
  });

  it('lets the host ready up and start only after the documented rule is met', async () => {
    const readyLobby: RoomPublicState = {
      ...lobby,
      players: [{ ...lobby.players[0]!, isReady: true }],
    };
    const startedLobby: RoomPublicState = {
      ...readyLobby,
      phase: 'COUNTDOWN',
      phaseEndsAtMs: 4_000,
    };
    const rooms = roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(lobby),
      setReady: vi.fn().mockResolvedValue(readyLobby),
      startMatch: vi.fn().mockResolvedValue(startedLobby),
    });
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms);
    await screen.findByRole('heading', { name: 'Crew at the carts.' });
    expect((screen.getByRole('button', { name: 'Start match' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'I’m ready' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Start match' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'Start match' }));
    expect((await screen.findByRole('status')).textContent).toContain('Match started');
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { ApiError, type AuthApi } from './api.js';
import type { RoomPublicState } from '@69-seconds/shared';
import type { RoomClient } from './room-client.js';
import type { GroceryGameFactory } from './game/types.js';

const player = {
  id: '477aa564-8b3f-4fa0-bf2c-c523add8d9ce',
  username: 'cart_goblin',
  email: 'player@example.com',
  createdAt: '2026-09-02T00:00:00.000Z',
};

const lobby: RoomPublicState = {
  code: 'ABC234',
  phase: 'LOBBY',
  hostPlayerId: player.id,
  players: [{
    id: player.id,
    displayName: player.username,
    slot: 0,
    isHost: true,
    isReady: false,
    isConnected: true,
    connectionState: 'CONNECTED',
    position: { x: 0, y: 0 },
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

const testGameFactory: GroceryGameFactory = (parent, callbacks) => {
  parent.append(document.createElement('canvas'));
  callbacks.onReady?.();
  return { destroy: () => undefined };
};

function renderAt(path: string, api: AuthApi, rooms: RoomClient = roomClientStub(), gameFactory = testGameFactory) {
  window.history.replaceState({}, '', path);
  return render(<App api={api} roomClient={rooms} gameFactory={gameFactory} />);
}

function openAccountMenu() {
  return userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
}

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('authentication application', () => {
  it('restores a current-user session into the protected room menu', async () => {
    const api = apiStub({ currentUser: vi.fn().mockResolvedValue(player) });
    renderAt('/home', api);
    expect(await screen.findByRole('button', { name: 'Create room' })).toBeTruthy();
    expect(api.currentUser).toHaveBeenCalledOnce();
    expect(screen.getByText('player@example.com')).toBeTruthy();
  });

  it('sends unauthenticated visitors back to the landing form', async () => {
    renderAt('/home', apiStub());
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });

  it('validates registration inline and completes the registration flow', async () => {
    const register = vi.fn().mockResolvedValue(player);
    renderAt('/', apiStub({ register }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Register' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Choose a username.')).toBeTruthy();
    expect(screen.getByText('Enter your email address.')).toBeTruthy();
    expect(screen.getByText('Enter a password.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Username'), 'Cart_Goblin');
    await userEvent.type(screen.getByLabelText('Email'), 'Player@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(register).toHaveBeenCalledWith({
      username: 'cart_goblin',
      email: 'player@example.com',
      password: 'correct-horse-battery',
    }));
    expect(await screen.findByRole('button', { name: 'Create room' })).toBeTruthy();
  });

  it('logs in with a username or an email address', async () => {
    const login = vi.fn().mockResolvedValue(player);
    renderAt('/', apiStub({ login }));
    await userEvent.type(await screen.findByLabelText('Username or email'), 'Cart_Goblin');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith({ identifier: 'cart_goblin', password: 'correct-horse-battery' }));
    await waitFor(() => expect(window.location.pathname).toBe('/home'));
  });

  it('presents a stable server error for a failed login', async () => {
    renderAt('/', apiStub({ login: vi.fn().mockRejectedValue(new ApiError('INVALID_CREDENTIALS', false, 'Nope')) }));
    await userEvent.type(await screen.findByLabelText('Username or email'), 'player@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'not-the-right-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Log in' }).closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain('Those credentials are incorrect.');
  });

  it('logs out from the account menu', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    renderAt('/home', apiStub({ currentUser: vi.fn().mockResolvedValue(player), logout }));
    await screen.findByRole('button', { name: 'Create room' });
    await openAccountMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(await screen.findByRole('tab', { name: 'Log in' })).toBeTruthy();
  });

  it('closes the account menu when the page is clicked elsewhere', async () => {
    renderAt('/home', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }));
    await screen.findByRole('button', { name: 'Create room' });
    await openAccountMenu();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull());
  });

  it('creates a private room from the menu and renders authoritative lobby status', async () => {
    const rooms = roomClientStub();
    renderAt('/home', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms);
    await userEvent.click(await screen.findByRole('button', { name: 'Create room' }));
    expect(await screen.findByText('ABC234')).toBeTruthy();
    expect(screen.getByText('cart_goblin (you)')).toBeTruthy();
    expect(screen.getByText('Host')).toBeTruthy();
    expect(rooms.createRoom).toHaveBeenCalledOnce();
  });

  it('validates join codes before sending a join command', async () => {
    const rooms = roomClientStub();
    renderAt('/home', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms);
    await userEvent.type(await screen.findByLabelText('Room code'), 'OOPS');
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
    await screen.findByText('ABC234');
    expect((screen.getByRole('button', { name: 'Start match' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Ready' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Start match' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'Start match' }));
    expect(await screen.findByRole('application', { name: /grocery store prototype/i })).toBeTruthy();
    expect(screen.getByText('COUNTDOWN')).toBeTruthy();
  });

  it('destroys the local Phaser instance when leaving the match route', async () => {
    const destroy = vi.fn();
    const gameFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      return { destroy };
    };
    const startedLobby: RoomPublicState = { ...lobby, phase: 'COUNTDOWN', phaseEndsAtMs: 4_000 };
    const rooms = roomClientStub({ joinRoom: vi.fn().mockResolvedValue(startedLobby) });
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms, gameFactory);
    await screen.findByRole('application', { name: /grocery store prototype/i });
    await userEvent.click(screen.getByRole('button', { name: 'Leave test' }));
    await waitFor(() => expect(destroy).toHaveBeenCalledWith(true));
    expect(await screen.findByRole('button', { name: 'Create room' })).toBeTruthy();
  });

  it('renders carry slots and local feedback through the narrow Phaser bridge', async () => {
    const bridgeFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      callbacks.onInventoryChange?.({
        carriedItems: [
          { id: 'loot-milk', label: 'Milk', shortLabel: 'MLK', color: '#83c6dc', pending: false },
          { id: 'loot-bread', label: 'Bread', shortLabel: 'BRD', color: '#eebd62', pending: true },
        ],
        depositedCount: 2,
        synchronized: true,
      });
      callbacks.onFeedback?.({ kind: 'PICKED_UP', message: 'Picked up Milk' });
      return { destroy: () => undefined };
    };
    const startedLobby: RoomPublicState = { ...lobby, phase: 'COUNTDOWN', phaseEndsAtMs: 4_000 };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(startedLobby),
    }), bridgeFactory);
    expect(await screen.findByLabelText('Milk in carry slot 1')).toBeTruthy();
    expect(screen.getByLabelText('Bread in carry slot 2, awaiting confirmation')).toBeTruthy();
    expect(screen.getByLabelText('2 items deposited')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Picked up Milk');
  });
});

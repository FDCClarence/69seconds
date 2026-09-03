import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { ApiError, type AuthApi } from './api.js';
import type { MatchTally, RoomPublicState } from '@69-seconds/shared';
import { RoomClientError, type RoomClient, type RoomClientListeners } from './room-client.js';
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
  window.localStorage.clear();
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
    expect(screen.getByText('At least 8 characters.')).toBeTruthy();
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
    expect(await screen.findByRole('application', { name: /grocery store/i })).toBeTruthy();
    expect(screen.getByText('GET READY')).toBeTruthy();
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
    await screen.findByRole('application', { name: /grocery store/i });
    await userEvent.click(screen.getByRole('button', { name: 'Leave match' }));
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

  it('renders the sprint bar and shove readiness through the narrow Phaser bridge', async () => {
    const bridgeFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      callbacks.onSprintChange?.({
        fraction: 0.42,
        sprinting: true,
        exhausted: false,
        shoveCooldownFraction: 0.5,
        recovering: false,
      });
      return { destroy: () => undefined };
    };
    const startedLobby: RoomPublicState = { ...lobby, phase: 'COUNTDOWN', phaseEndsAtMs: 4_000 };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(startedLobby),
    }), bridgeFactory);

    const stamina = await screen.findByLabelText('Sprint stamina 42 percent');
    expect(stamina.getAttribute('aria-valuenow')).toBe('42');
    const shove = screen.getByLabelText('Shove recharging');
    expect(shove.getAttribute('aria-valuenow')).toBe('50');
  });

  it('announces a spent bar and a shove recovery on the sprint meter itself', async () => {
    const bridgeFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      callbacks.onSprintChange?.({
        fraction: 0,
        sprinting: false,
        exhausted: true,
        shoveCooldownFraction: 0,
        recovering: true,
      });
      callbacks.onFeedback?.({ kind: 'SHOVE_TAKEN', message: 'Shoved · regaining your footing' });
      return { destroy: () => undefined };
    };
    const startedLobby: RoomPublicState = { ...lobby, phase: 'COUNTDOWN', phaseEndsAtMs: 4_000 };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(startedLobby),
    }), bridgeFactory);

    expect(await screen.findByLabelText(
      'Sprint stamina 0 percent, spent — walk to recover, recovering from a shove',
    )).toBeTruthy();
    expect(screen.getByLabelText('Shove ready')).toBeTruthy();
    expect(screen.getByText('Shoved · regaining your footing')).toBeTruthy();
  });

  it('displays the looting clock from server timestamps', async () => {
    const looting: RoomPublicState = {
      ...lobby,
      phase: 'LOOTING',
      serverTimeMs: 5_000,
      phaseEndsAtMs: 5_000 + 69_000,
    };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(looting),
    }));
    expect(await screen.findByText('1:09')).toBeTruthy();
  });

  it('keeps gameplay keys scoped, prevents browser actions, and exposes rebindable controls', async () => {
    const startedLobby: RoomPublicState = { ...lobby, phase: 'COUNTDOWN', phaseEndsAtMs: 4_000 };
    const nativeGameKeyDown = vi.fn();
    const synchronizedFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.addEventListener('keydown', nativeGameKeyDown);
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      callbacks.onInventoryChange?.({ carriedItems: [], depositedCount: 0, synchronized: true });
      return { destroy: () => parent.removeEventListener('keydown', nativeGameKeyDown) };
    };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(startedLobby),
    }), synchronizedFactory);

    const game = await screen.findByRole('application', { name: /grocery store/i });
    game.focus();
    const move = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true });
    const space = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    const control = new KeyboardEvent('keydown', { code: 'ControlLeft', key: 'Control', bubbles: true, cancelable: true });
    expect(game.dispatchEvent(move)).toBe(false);
    expect(game.dispatchEvent(space)).toBe(false);
    expect(game.dispatchEvent(control)).toBe(false);
    expect(nativeGameKeyDown.mock.calls.map((call) => (call[0] as KeyboardEvent).code)).toEqual([
      'KeyW', 'Space', 'ControlLeft',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('complementary', { name: 'Game settings' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Move up key: W/i }));
    fireEvent.keyDown(window, { code: 'ArrowUp', key: 'ArrowUp' });
    expect(screen.getByRole('button', { name: /Move up key: ↑/i })).toBeTruthy();
    expect(screen.getByLabelText('Music volume')).toBeTruthy();
    expect(screen.getByLabelText('Sound effects volume')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows loading and connection loss as explicit non-color-only status', async () => {
    let listeners: RoomClientListeners | undefined;
    const startedLobby: RoomPublicState = { ...lobby, phase: 'COUNTDOWN', phaseEndsAtMs: 4_000 };
    const rooms = roomClientStub({
      subscribe: vi.fn((next) => {
        listeners = next;
        next.onConnection('CONNECTED');
        return () => undefined;
      }),
      joinRoom: vi.fn().mockResolvedValue(startedLobby),
    });
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms);
    expect(await screen.findByText('Synchronizing inventory')).toBeTruthy();

    act(() => listeners?.onConnection('RECONNECTING'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Connection lost — reconnecting');
    expect(alert.textContent).toContain('server still owns the match clock');
  });

  it('returns to login when the realtime session is revoked or expires', async () => {
    let listeners: RoomClientListeners | undefined;
    const rooms = roomClientStub({
      subscribe: vi.fn((next) => {
        listeners = next;
        next.onConnection('CONNECTED');
        return () => undefined;
      }),
    });
    renderAt('/home', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms);
    await screen.findByRole('button', { name: 'Create room' });

    act(() => listeners?.onError(new RoomClientError(
      'UNAUTHENTICATED',
      'Your session has expired',
      false,
    )));

    expect(await screen.findByRole('tab', { name: 'Log in' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Your session expired');
    expect(window.location.pathname).toBe('/');
    expect(rooms.disconnect).toHaveBeenCalled();
  });

  it('keeps an unacknowledged network outcome visible until dismissed', async () => {
    const startedLobby: RoomPublicState = { ...lobby, phase: 'LOOTING', phaseEndsAtMs: 70_000 };
    const failingFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      callbacks.onInventoryChange?.({ carriedItems: [], depositedCount: 0, synchronized: true });
      callbacks.onFeedback?.({ kind: 'DESYNCHRONIZED', message: 'The server did not confirm that interaction' });
      return { destroy: () => undefined };
    };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(startedLobby),
    }), failingFactory);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Network error');
    expect(alert.textContent).toContain('did not confirm');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss network error' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('destroys Phaser at TALLY, waits for the server result, and renders the immutable tally', async () => {
    let listeners: RoomClientListeners | undefined;
    const destroy = vi.fn();
    const started: RoomPublicState = { ...lobby, phase: 'LOOTING', phaseEndsAtMs: 70_000 };
    const tallyRoom: RoomPublicState = { ...started, phase: 'TALLY', phaseEndsAtMs: null };
    const result: MatchTally = {
      resultId: 'ABC234:70000',
      roomCode: 'ABC234',
      lootingStartedAtMs: 1_000,
      lootingEndedAtMs: 70_000,
      durationMs: 69_000,
      totalItems: 2,
      categoryTotals: [{ category: 'dairy', count: 1 }, { category: 'bakery', count: 1 }],
      players: [{
        playerId: player.id,
        displayName: player.username,
        slot: 0,
        isConnectedAtEnd: true,
        totalItems: 2,
        categoryTotals: [{ category: 'dairy', count: 1 }, { category: 'bakery', count: 1 }],
        items: [
          { id: 'loot-milk', catalogId: 'milk', label: 'Milk', category: 'dairy' },
          { id: 'loot-bread', catalogId: 'bread', label: 'Bread', category: 'bakery' },
        ],
      }],
    };
    const rooms = roomClientStub({
      subscribe: vi.fn((next) => {
        listeners = next;
        next.onConnection('CONNECTED');
        return () => undefined;
      }),
      joinRoom: vi.fn().mockResolvedValue(started),
    });
    const gameFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      return { destroy };
    };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms, gameFactory);
    await screen.findByRole('application', { name: /grocery store/i });

    act(() => listeners?.onRoom(tallyRoom));
    expect(await screen.findByText('Waiting for the server’s final tally…')).toBeTruthy();
    expect(screen.queryByRole('application')).toBeNull();
    expect(destroy).toHaveBeenCalledWith(true);

    act(() => listeners?.onResult?.(result));
    expect(await screen.findByRole('heading', { name: 'Time’s up.' })).toBeTruthy();
    expect(screen.getByLabelText('2 items deposited in total')).toBeTruthy();
    expect(screen.getByText('Milk')).toBeTruthy();
    expect(screen.getByText('Bread')).toBeTruthy();
    expect(screen.getByText('Present at the buzzer')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Return home' }));
    await waitFor(() => expect(rooms.leaveRoom).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: 'Create room' })).toBeTruthy();
  });
});

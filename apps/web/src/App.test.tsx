import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { ApiError, type AuthApi } from './api.js';
import {
  GAME,
  SURVIVAL,
  SURVIVAL_CHARACTER_DEFAULTS,
  npcCatalogEntry,
  npcImageUrl,
  npcSpriteCrop,
  type MatchTally,
  type RoomPublicState,
  type SurvivalState,
} from '@69-seconds/shared';
import { RoomClientError, type RoomClient, type RoomClientListeners } from './room-client.js';
import type { GroceryGameFactory } from './game/types.js';
import { forgetDayTransitions } from './survival/day-transition-memory.js';
import { DAY_TRANSITION_TOTAL_MS } from './survival/DayTransition.js';

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
          { id: 'loot-water', label: 'Bottled Water', shortLabel: 'WTR', color: '#6fb7d8', imageUrl: '/item_images/bottled-water.png', slotCost: 1, isNpc: false, crop: null, pending: false },
          { id: 'loot-map', label: 'Map', shortLabel: 'MAP', color: '#c2b280', imageUrl: null, slotCost: 1, isNpc: false, crop: null, pending: true },
        ],
        slotsUsed: 2,
        depositedCount: 2,
        synchronized: true,
      });
      callbacks.onFeedback?.({ kind: 'PICKED_UP', message: 'Picked up Bottled Water' });
      return { destroy: () => undefined };
    };
    const startedLobby: RoomPublicState = { ...lobby, phase: 'COUNTDOWN', phaseEndsAtMs: 4_000 };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(startedLobby),
    }), bridgeFactory);
    expect(await screen.findByLabelText('Bottled Water in carry slot 1')).toBeTruthy();
    expect(screen.getByLabelText('Map in carry slot 2, awaiting confirmation')).toBeTruthy();
    expect(screen.getByLabelText('2 items deposited')).toBeTruthy();
    // Illustrated items show their art; an item with none falls back to a `?` chip.
    expect(screen.getByTitle('Bottled Water').getAttribute('src')).toBe('/item_images/bottled-water.png');
    expect(screen.getByTitle('Map').textContent).toBe('?');
    expect(screen.getByRole('status').textContent).toContain('Picked up Bottled Water');
  });

  it('shows a carried person in the first slot and blocks the rest', async () => {
    const maya = npcCatalogEntry('maya');
    const bridgeFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      callbacks.onInventoryChange?.({
        carriedItems: [{
          id: 'npc-maya',
          label: maya.name,
          shortLabel: maya.shortLabel,
          color: '#5fb0a8',
          imageUrl: npcImageUrl(maya),
          slotCost: GAME.maxCarriedItems,
          isNpc: true,
          crop: npcSpriteCrop(maya),
          pending: false,
        }],
        slotsUsed: GAME.maxCarriedItems,
        depositedCount: 0,
        synchronized: true,
      });
      return { destroy: () => undefined };
    };
    const startedLobby: RoomPublicState = { ...lobby, phase: 'COUNTDOWN', phaseEndsAtMs: 4_000 };
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), roomClientStub({
      joinRoom: vi.fn().mockResolvedValue(startedLobby),
    }), bridgeFactory);

    expect(await screen.findByLabelText('Maya, carried person filling every slot, in carry slot 1')).toBeTruthy();
    // The other three slots read as taken by her, not as empty and pickable.
    for (const slot of [2, 3, 4]) {
      expect(screen.getByLabelText(`Carry slot ${slot} taken up by Maya`).textContent).toContain('✕');
    }
    expect(screen.queryByLabelText('Empty carry slot 2')).toBeNull();
    expect(screen.getByLabelText(`${GAME.maxCarriedItems} of ${GAME.maxCarriedItems} carry slots filled`)).toBeTruthy();
    // Her portrait is positioned from the catalog crop, not stretched to the box.
    const portrait = screen.getByTitle('Maya').querySelector('img');
    expect(portrait?.getAttribute('src')).toBe(npcImageUrl(maya));
    expect(portrait?.style.height).toBe(`${npcSpriteCrop(maya).heightPercent}%`);
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
    // Mirrors Phaser's KeyboardManager: a bubble-phase listener on the game host
    // that reads `defaultPrevented` at delivery time and drops handled events.
    const gameKeysSeen: { code: string; defaultPrevented: boolean }[] = [];
    const nativeGameKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      gameKeysSeen.push({ code: event.code, defaultPrevented: event.defaultPrevented });
    };
    const synchronizedFactory: GroceryGameFactory = (parent, callbacks) => {
      parent.addEventListener('keydown', nativeGameKeyDown as EventListener);
      parent.append(document.createElement('canvas'));
      callbacks.onReady?.();
      callbacks.onInventoryChange?.({ carriedItems: [], slotsUsed: 0, depositedCount: 0, synchronized: true });
      return { destroy: () => parent.removeEventListener('keydown', nativeGameKeyDown as EventListener) };
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
    // Phaser's KeyboardManager listens on this same host element in the bubble
    // phase and ignores any event that is already `defaultPrevented`, so the
    // browser default must be cancelled after the game has read the key, never
    // before it. Cancelling in the capture phase leaves the shopper unable to
    // move, sprint, interact or shove for the whole match.
    expect(gameKeysSeen).toEqual([
      { code: 'KeyW', defaultPrevented: false },
      { code: 'Space', defaultPrevented: false },
      { code: 'ControlLeft', defaultPrevented: false },
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
      callbacks.onInventoryChange?.({ carriedItems: [], slotsUsed: 0, depositedCount: 0, synchronized: true });
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

  it('recognizes SURVIVAL, leaves the looting scene, and renders the placeholder day', async () => {
    let listeners: RoomClientListeners | undefined;
    const destroy = vi.fn();
    const started: RoomPublicState = { ...lobby, phase: 'LOOTING', phaseEndsAtMs: 70_000 };
    const survivalRoom: RoomPublicState = {
      ...started,
      phase: 'SURVIVAL',
      // The client only reads this deadline; it never sets one of its own.
      phaseEndsAtMs: 70_000 + GAME.survivalDurationMs,
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

    act(() => listeners?.onRoom(survivalRoom));
    expect(await screen.findByRole('heading', { name: 'Survival phase' })).toBeTruthy();
    expect(screen.queryByRole('application')).toBeNull();
    expect(destroy).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('heading', { name: 'Time’s up.' })).toBeNull();
  });

  it('announces the authoritative survival day, then reveals the screen without telling the server', async () => {
    forgetDayTransitions();
    let listeners: RoomClientListeners | undefined;
    const started: RoomPublicState = { ...lobby, phase: 'LOOTING', phaseEndsAtMs: 70_000 };
    const survivalDeadline = 70_000 + GAME.survivalDurationMs;
    const survivalRoom: RoomPublicState = { ...started, phase: 'SURVIVAL', phaseEndsAtMs: survivalDeadline };
    // The server's own state. Day 1 is what it committed; the client counts none.
    const survivalState: SurvivalState = {
      stateId: 'survival:ABC234:70000',
      roomCode: 'ABC234',
      dayNumber: SURVIVAL.firstDayNumber,
      startedAtMs: 70_000,
      households: [{
        playerId: player.id,
        displayName: player.username,
        slot: 0,
        characters: [{
          id: player.id,
          displayName: player.username,
          kind: 'MAIN',
          catalogId: null,
          isAlive: true,
          stats: SURVIVAL_CHARACTER_DEFAULTS.stats,
          dailyNutritionCost: SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
          dailyHydrationCost: SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost,
        }],
        inventory: [],
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
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms);
    await screen.findByRole('application', { name: /grocery store/i });

    // Fake timers from here, so the two-second overlay can be run out.
    vi.useFakeTimers();
    try {
      act(() => {
        listeners?.onRoom(survivalRoom);
        listeners?.onSurvivalState?.(survivalState);
      });
      expect(screen.getByRole('heading', { name: 'Survival phase' })).toBeTruthy();
      // The rendered day is the one the server sent, not a client-side 1.
      expect(screen.getByRole('status').textContent).toBe(`Day #${survivalState.dayNumber}`);
      expect(document.querySelector('.day-transition')?.getAttribute('data-day')).toBe('1');

      act(() => { vi.advanceTimersByTime(DAY_TRANSITION_TOTAL_MS); });
      // The overlay fades away and the survival screen underneath is revealed.
      expect(document.querySelector('.day-transition')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Survival phase' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }

    // Presentational only: finishing the animation sends nothing, and the day's
    // server-owned deadline is still exactly the one the server published.
    expect(rooms.setReady).not.toHaveBeenCalled();
    expect(rooms.startMatch).not.toHaveBeenCalled();
    expect(rooms.leaveRoom).not.toHaveBeenCalled();
    expect(rooms.joinRoom).toHaveBeenCalledTimes(1);
    expect(survivalRoom.phaseEndsAtMs).toBe(survivalDeadline);
    expect(survivalState.startedAtMs).toBe(70_000);
  });

  it('replays no transition when the survival screen remounts on the same day', async () => {
    forgetDayTransitions();
    let listeners: RoomClientListeners | undefined;
    const survivalRoom: RoomPublicState = {
      ...lobby,
      phase: 'SURVIVAL',
      phaseEndsAtMs: 70_000 + GAME.survivalDurationMs,
    };
    const survivalState: SurvivalState = {
      stateId: 'survival:ABC234:70000',
      roomCode: 'ABC234',
      dayNumber: 1,
      startedAtMs: 70_000,
      households: [{
        playerId: player.id,
        displayName: player.username,
        slot: 0,
        characters: [{
          id: player.id,
          displayName: player.username,
          kind: 'MAIN',
          catalogId: null,
          isAlive: true,
          stats: SURVIVAL_CHARACTER_DEFAULTS.stats,
          dailyNutritionCost: SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
          dailyHydrationCost: SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost,
        }],
        inventory: [],
      }],
    };
    const rooms = () => roomClientStub({
      subscribe: vi.fn((next) => {
        listeners = next;
        next.onConnection('CONNECTED');
        return () => undefined;
      }),
      joinRoom: vi.fn().mockResolvedValue(survivalRoom),
    });

    const first = renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms());
    await screen.findByRole('heading', { name: 'Survival phase' });
    act(() => { listeners?.onSurvivalState?.(survivalState); });
    expect(screen.getByRole('status').textContent).toBe('Day #1');
    // Watched on the real clock, because what stops the replay is elapsed time
    // rather than a mount count.
    await waitFor(
      () => expect(document.querySelector('.day-transition')).toBeNull(),
      { timeout: DAY_TRANSITION_TOTAL_MS * 2 },
    );
    first.unmount();

    // A reconnecting client is sent the same committed state again. The day it
    // observes has not changed, so it lands on the survival screen directly.
    renderAt('/room/ABC234', apiStub({ currentUser: vi.fn().mockResolvedValue(player) }), rooms());
    await screen.findByRole('heading', { name: 'Survival phase' });
    act(() => { listeners?.onSurvivalState?.(survivalState); });
    expect(document.querySelector('.day-transition')).toBeNull();
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
      categoryTotals: [{ category: 'food', count: 1 }, { category: 'misc', count: 1 }],
      players: [{
        playerId: player.id,
        displayName: player.username,
        slot: 0,
        isConnectedAtEnd: true,
        totalItems: 2,
        categoryTotals: [{ category: 'food', count: 1 }, { category: 'misc', count: 1 }],
        items: [
          { id: 'loot-water', catalogId: 'bottled-water', label: 'Bottled Water', category: 'food' },
          { id: 'loot-map', catalogId: 'map', label: 'Map', category: 'misc' },
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
    expect(screen.getByText('Bottled Water')).toBeTruthy();
    expect(screen.getByText('Map')).toBeTruthy();
    expect(screen.getByText('Present at the buzzer')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Return home' }));
    await waitFor(() => expect(rooms.leaveRoom).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: 'Create room' })).toBeTruthy();
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  GAME,
  SURVIVAL_CHARACTER_DEFAULTS,
  type PublicUser,
  type RoomPublicState,
  type SurvivalCharacter,
  type SurvivalConsumeResult,
  type SurvivalReadinessState,
  type SurvivalState,
} from '@69-seconds/shared';
import { SurvivalDay } from './SurvivalDay.js';
import { forgetDayTransitions } from './day-transition-memory.js';
import { RoomClientError, type RoomClient } from '../room-client.js';

const user: PublicUser = {
  id: '477aa564-8b3f-4fa0-bf2c-c523add8d9ce',
  username: 'cart_goblin',
  email: 'player@example.com',
  createdAt: '2026-09-02T00:00:00.000Z',
};

const RIVAL_ID = '9c1f2f0e-0c2f-4f0a-9d43-2f52a2b0c111';
/** The authoritative looting deadline every fixture day opens on. */
const DAY_STARTED_AT_MS = 70_000;
const DAY_ENDS_AT_MS = DAY_STARTED_AT_MS + GAME.survivalDurationMs;

function character(overrides: Partial<SurvivalCharacter> = {}): SurvivalCharacter {
  return {
    id: user.id,
    displayName: user.username,
    kind: 'MAIN',
    catalogId: null,
    isAlive: true,
    stats: SURVIVAL_CHARACTER_DEFAULTS.stats,
    dailyNutritionCost: SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
    dailyHydrationCost: SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost,
    ...overrides,
  };
}

const recruit = character({
  id: 'item-gort-1',
  displayName: 'Gort',
  kind: 'NPC',
  catalogId: 'gort',
  stats: {
    ...SURVIVAL_CHARACTER_DEFAULTS.stats,
    nutrition: { current: 40, max: 100 },
    hydration: { current: 20, max: 100 },
  },
  dailyNutritionCost: 30,
});

function room(overrides: Partial<RoomPublicState> = {}): RoomPublicState {
  return {
    code: 'ABC234',
    phase: 'SURVIVAL',
    hostPlayerId: user.id,
    players: [{
      id: user.id,
      displayName: user.username,
      slot: 0,
      isHost: true,
      isReady: true,
      isConnected: true,
      connectionState: 'CONNECTED',
      position: { x: 0, y: 0 },
    }],
    // The server's own clock, which is what the day countdown is read against.
    serverTimeMs: DAY_STARTED_AT_MS,
    phaseEndsAtMs: DAY_ENDS_AT_MS,
    ...overrides,
  };
}

function survivalState(overrides: Partial<SurvivalState> = {}): SurvivalState {
  return {
    stateId: 'survival:ABC234:70000',
    roomCode: 'ABC234',
    dayNumber: 1,
    startedAtMs: DAY_STARTED_AT_MS,
    households: [{
      playerId: user.id,
      displayName: user.username,
      slot: 0,
      characters: [character(), recruit],
      inventory: [
        { id: 'item-soup-1', catalogId: 'canned-soup', label: 'Canned Soup', category: 'food' },
        { id: 'item-soup-2', catalogId: 'canned-soup', label: 'Canned Soup', category: 'food' },
        { id: 'item-pistol-1', catalogId: 'pistol', label: 'Pistol', category: 'weapons' },
      ],
    }],
    ...overrides,
  };
}

function readinessState(overrides: Partial<SurvivalReadinessState> = {}): SurvivalReadinessState {
  return {
    roomCode: 'ABC234',
    dayNumber: 1,
    startedAtMs: DAY_STARTED_AT_MS,
    endsAtMs: DAY_ENDS_AT_MS,
    durationMs: GAME.survivalDurationMs,
    players: [{ playerId: user.id, hasEnded: false, endedAtMs: null, endedBy: null }],
    activePlayerCount: 1,
    allPlayersEnded: false,
    ...overrides,
  };
}

function consumed(overrides: Partial<Extract<SurvivalConsumeResult, { outcome: 'CONSUMED' }>> = {}) {
  return {
    outcome: 'CONSUMED' as const,
    requestId: '00000000-0000-4000-8000-000000000001',
    itemId: 'item-soup-1',
    catalogId: 'canned-soup',
    character: recruit,
    inventory: [],
    ...overrides,
  };
}

function clientStub(overrides: Partial<RoomClient> = {}): RoomClient {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    setReady: vi.fn(),
    startMatch: vi.fn(),
    endDay: vi.fn().mockResolvedValue(readinessState()),
    consumeItem: vi.fn().mockResolvedValue(consumed()),
    ...overrides,
  };
}

function renderDay(props: Partial<Parameters<typeof SurvivalDay>[0]> = {}) {
  forgetDayTransitions();
  const roomClient = props.roomClient ?? clientStub();
  const view = render(<SurvivalDay
    room={props.room ?? room()}
    state={props.state === undefined ? survivalState() : props.state}
    readiness={props.readiness === undefined ? readinessState() : props.readiness}
    user={user}
    connection={props.connection ?? 'CONNECTED'}
    roomClient={roomClient}
    onLeave={props.onLeave ?? vi.fn().mockResolvedValue(undefined)}
  />);
  return { ...view, roomClient };
}

describe('survival day screen', () => {
  it('renders the server’s day, its deadline, and who has ended it', () => {
    renderDay({
      state: survivalState({ dayNumber: 4 }),
      readiness: readinessState({
        dayNumber: 4,
        players: [
          { playerId: user.id, hasEnded: false, endedAtMs: null, endedBy: null },
          { playerId: RIVAL_ID, hasEnded: true, endedAtMs: DAY_STARTED_AT_MS + 5_000, endedBy: 'MANUAL' },
        ],
        activePlayerCount: 1,
      }),
    });

    expect(screen.getByRole('heading', { name: 'Survival phase' })).toBeTruthy();
    // The day is the server's number, never a count this screen kept.
    expect(screen.getByText(/Day 4\./)).toBeTruthy();
    // A full 120-second window remains, measured from the server's own clock.
    expect(screen.getByRole('timer').textContent).toBe('2:00');
    expect(screen.getByText(/1 of 2 households ended/)).toBeTruthy();
  });

  it('shows one house per household, dimmed once the server says that household ended', () => {
    const { container } = renderDay({
      state: survivalState({
        households: [
          survivalState().households[0]!,
          { playerId: RIVAL_ID, displayName: 'rival_raider', slot: 1, characters: [], inventory: [] },
        ],
      }),
      readiness: readinessState({
        players: [
          { playerId: user.id, hasEnded: false, endedAtMs: null, endedBy: null },
          { playerId: RIVAL_ID, hasEnded: true, endedAtMs: DAY_STARTED_AT_MS + 5_000, endedBy: 'MANUAL' },
        ],
        activePlayerCount: 1,
      }),
    });

    // One house per household in the server's readiness list, in its order.
    const houses = [...container.querySelectorAll('.survival-house-marker')];
    expect(houses.map((house) => house.textContent)).toEqual([
      'cart_goblin (you)· still deciding',
      'rival_raider· day ended',
    ]);
    // Dimming is the signal, and it belongs to the household the server ended.
    expect(houses.map((house) => house.classList.contains('is-ended'))).toEqual([false, true]);
    expect(houses[0]!.querySelector('.survival-house-glyph')).toBeTruthy();
  });

  it('dims every house once every household has ended the day', () => {
    const { container } = renderDay({
      readiness: readinessState({
        players: [{ playerId: user.id, hasEnded: true, endedAtMs: DAY_STARTED_AT_MS + 1_000, endedBy: 'MANUAL' }],
        activePlayerCount: 0,
        allPlayersEnded: true,
      }),
    });

    const houses = [...container.querySelectorAll('.survival-house-marker')];
    expect(houses).toHaveLength(1);
    expect(houses[0]!.classList.contains('is-ended')).toBe(true);
  });

  it('shows each character’s authoritative resources and their own daily costs', () => {
    renderDay();

    const nutrition = screen.getByRole('meter', { name: 'Gort Nutrition' });
    expect(nutrition.getAttribute('aria-valuenow')).toBe('40');
    expect(nutrition.getAttribute('aria-valuemax')).toBe('100');
    const hydration = screen.getByRole('meter', { name: 'Gort Hydration' });
    expect(hydration.getAttribute('aria-valuenow')).toBe('20');

    // Costs are per character: the recruit drains faster than the main.
    expect(screen.getByText('40/100 · −30/day')).toBeTruthy();
    expect(screen.getByText('20/100 · −20/day')).toBeTruthy();
    expect(screen.getAllByText('100/100 · −20/day').length).toBe(2);
    // The four stats a day does not move are still shown, as the server has them.
    expect(screen.getAllByText(/Health 100 · Survival 50 · Morale 100 · Strength 50/).length).toBe(2);
  });

  it('feeds one owned item to the chosen character and reports what the server committed', async () => {
    const { roomClient } = renderDay();

    await userEvent.click(screen.getByRole('radio', { name: 'Gort' }));
    await userEvent.click(screen.getByRole('button', { name: 'Feed Canned Soup to Gort' }));

    expect(roomClient.consumeItem).toHaveBeenCalledTimes(1);
    const request = vi.mocked(roomClient.consumeItem!).mock.calls[0]![0];
    // Only the two ids travel: one owned item instance, one owned character.
    expect(Object.keys(request).sort()).toEqual(['characterId', 'itemId', 'requestId']);
    expect(request.itemId).toBe('item-soup-1');
    expect(request.characterId).toBe(recruit.id);
    expect(request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(await screen.findByText('Fed Canned Soup to Gort.')).toBeTruthy();
  });

  it('defaults to the household’s own main character when nothing was chosen', async () => {
    const { roomClient } = renderDay();

    await userEvent.click(screen.getByRole('button', { name: `Feed Canned Soup to ${user.username}` }));

    expect(vi.mocked(roomClient.consumeItem!).mock.calls[0]![0].characterId).toBe(user.id);
  });

  it('shows the server’s own reason for a refused feed and never invents a restoration', async () => {
    const consumeItem = vi.fn().mockResolvedValue({
      outcome: 'REJECTED',
      requestId: '00000000-0000-4000-8000-000000000002',
      reason: 'DAY_ALREADY_ENDED',
      message: 'Your household has already ended this day',
    });
    renderDay({ roomClient: clientStub({ consumeItem }) });

    await userEvent.click(screen.getByRole('button', { name: `Feed Canned Soup to ${user.username}` }));

    expect(await screen.findByText('Your household has already ended this day')).toBeTruthy();
    // The rejection restated nothing, so the rendered stats are still the day's.
    expect(screen.getByRole('meter', { name: `${user.username} Nutrition` }).getAttribute('aria-valuenow'))
      .toBe('100');
  });

  it('offers no feed action for an item the shared table says is not food', () => {
    renderDay();

    expect(screen.getByText('Pistol')).toBeTruthy();
    expect(screen.getByText('Not edible')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Feed Pistol/ })).toBeNull();
    // One button per edible group, not per instance: two soups share one.
    expect(screen.getAllByRole('button', { name: /^Feed / }).length).toBe(1);
    expect(screen.getByText('2x')).toBeTruthy();
  });

  it('sends End Day once and then offers no further action for the day', async () => {
    const { roomClient, rerender } = renderDay();

    await userEvent.click(screen.getByRole('button', { name: 'End day' }));
    expect(roomClient.endDay).toHaveBeenCalledTimes(1);

    // The server's readiness broadcast is what actually closes the screen down.
    rerender(<SurvivalDay
      room={room()}
      state={survivalState()}
      readiness={readinessState({
        players: [{
          playerId: user.id,
          hasEnded: true,
          endedAtMs: DAY_STARTED_AT_MS + 1_000,
          endedBy: 'MANUAL',
        }],
        activePlayerCount: 0,
        allPlayersEnded: true,
      })}
      user={user}
      connection="CONNECTED"
      roomClient={roomClient}
      onLeave={vi.fn()}
    />);

    expect(screen.getByRole('button', { name: 'Day ended' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/you have ended your day/)).toBeTruthy();
    const feed = screen.getByRole('button', { name: `Feed Canned Soup to ${user.username}` });
    expect(feed.hasAttribute('disabled')).toBe(true);
    await userEvent.click(feed);
    expect(roomClient.consumeItem).not.toHaveBeenCalled();
  });

  it('locks the day at the server’s deadline without ending it itself', () => {
    const { roomClient } = renderDay({ room: room({ serverTimeMs: DAY_ENDS_AT_MS }) });

    expect(screen.getByRole('timer').textContent).toBe('0:00');
    expect(screen.getByRole('button', { name: 'End day' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: `Feed Canned Soup to ${user.username}` }).hasAttribute('disabled'))
      .toBe(true);
    // Nothing was sent: the server resolves an expired day on its own clock.
    expect(roomClient.endDay).not.toHaveBeenCalled();
  });

  it('offers nothing while a reconnecting client waits for the server', () => {
    renderDay({ connection: 'RECONNECTING' });

    expect(screen.getByRole('button', { name: 'End day' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: `Feed Canned Soup to ${user.username}` }).hasAttribute('disabled'))
      .toBe(true);
  });

  it('waits for the server’s households instead of rendering one of its own', () => {
    renderDay({ state: null, readiness: null });

    expect(screen.getByRole('heading', { name: 'Survival phase' })).toBeTruthy();
    expect(screen.getByText('Waiting for the server’s households…')).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toBe('--:--');
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Feed / })).toBeNull();
  });

  it('renders other households read-only, with no way to feed or end for them', () => {
    renderDay({
      state: survivalState({
        households: [
          survivalState().households[0]!,
          {
            playerId: RIVAL_ID,
            displayName: 'aisle_gremlin',
            slot: 1,
            characters: [character({ id: RIVAL_ID, displayName: 'aisle_gremlin' })],
            inventory: [{ id: 'item-water-9', catalogId: 'bottled-water', label: 'Bottled Water', category: 'food' }],
          },
        ],
      }),
      readiness: readinessState({
        players: [
          { playerId: user.id, hasEnded: false, endedAtMs: null, endedBy: null },
          { playerId: RIVAL_ID, hasEnded: true, endedAtMs: DAY_STARTED_AT_MS + 2_000, endedBy: 'MANUAL' },
        ],
        activePlayerCount: 1,
      }),
    });

    expect(screen.getByRole('heading', { name: 'aisle_gremlin' })).toBeTruthy();
    expect(screen.getByText('Day ended')).toBeTruthy();
    expect(screen.getByText('1 item left')).toBeTruthy();
    // The rival's water is theirs: this screen exposes no action against it.
    expect(screen.queryByRole('button', { name: /Feed Bottled Water/ })).toBeNull();
    expect(screen.getAllByRole('radio').length).toBe(2);
  });

  it('cannot select or feed a dead character', async () => {
    const { roomClient } = renderDay({
      state: survivalState({
        households: [{
          ...survivalState().households[0]!,
          characters: [character({ isAlive: false }), recruit],
        }],
      }),
    });

    expect(screen.getByRole('radio', { name: user.username }).hasAttribute('disabled')).toBe(true);
    // The only living character is the fallback selection, so a feed targets them.
    await userEvent.click(screen.getByRole('button', { name: 'Feed Canned Soup to Gort' }));
    expect(vi.mocked(roomClient.consumeItem!).mock.calls[0]![0].characterId).toBe(recruit.id);
  });

  it('warns with the odds the server will roll, on what the day will leave behind', () => {
    renderDay();

    // Gort ends the day on 10 food and 0 water once their own 30/20 is spent,
    // which is the shared table's 50% band — the same number the server rolls.
    expect(screen.getByText(/50% chance of dying tonight/)).toBeTruthy();
    // The main character ends it on 80 and 80 and is warned about at all.
    expect(screen.getAllByText(/chance of dying tonight/).length).toBe(1);
  });

  it('reads each band from the shared rule rather than a threshold of its own', () => {
    // Each pair is what the character holds now; the day's 20 and 20 come off
    // before the band is read, so 40 + 20 lands them exactly on safe.
    const cases = [[10, 10, '99%'], [25, 20, '80%'], [30, 20, '50%'], [40, 20, null]] as const;
    for (const [nutrition, hydration, odds] of cases) {
      const { unmount } = renderDay({
        state: survivalState({
          households: [{
            ...survivalState().households[0]!,
            characters: [character({
              stats: {
                ...SURVIVAL_CHARACTER_DEFAULTS.stats,
                nutrition: { current: nutrition, max: 100 },
                hydration: { current: hydration, max: 100 },
              },
            })],
          }],
        }),
      });
      if (odds === null) expect(screen.queryByText(/chance of dying tonight/)).toBeNull();
      else expect(screen.getByText(new RegExp(`${odds} chance of dying tonight`))).toBeTruthy();
      unmount();
    }
  });

  it('never warns about a character who is already dead', () => {
    renderDay({
      state: survivalState({
        households: [{
          ...survivalState().households[0]!,
          // Empty and dead: the worst numbers there are, and no risk left to
          // warn about, because the night no longer rolls for them.
          characters: [character({
            isAlive: false,
            stats: {
              ...SURVIVAL_CHARACTER_DEFAULTS.stats,
              nutrition: { current: 0, max: 100 },
              hydration: { current: 0, max: 100 },
            },
          })],
        }],
      }),
    });

    expect(screen.queryByText(/chance of dying tonight/)).toBeNull();
  });

  it('reports who did not survive the night when the server opens the next day', async () => {
    const { roomClient, rerender } = renderDay();
    expect(screen.queryByText(/did not survive the night/)).toBeNull();

    const nextDayStartedAtMs = DAY_ENDS_AT_MS;
    const nextDay = (dayNumber: number) => <SurvivalDay
      room={room({ serverTimeMs: nextDayStartedAtMs, phaseEndsAtMs: nextDayStartedAtMs + GAME.survivalDurationMs })}
      state={survivalState({
        dayNumber,
        startedAtMs: nextDayStartedAtMs,
        households: [{
          ...survivalState().households[0]!,
          // The server's own committed outcome: Gort lost the 50% roll.
          characters: [character(), { ...recruit, isAlive: false }],
        }],
      })}
      readiness={readinessState({
        dayNumber,
        startedAtMs: nextDayStartedAtMs,
        endsAtMs: nextDayStartedAtMs + GAME.survivalDurationMs,
      })}
      user={user}
      connection="CONNECTED"
      roomClient={roomClient}
      onLeave={vi.fn()}
    />;
    rerender(nextDay(2));

    expect(await screen.findByText('Gort did not survive the night.')).toBeTruthy();
    // Death is read off the committed households, so the card agrees with it.
    expect(screen.getByRole('radio', { name: 'Gort' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/chance of dying tonight/)).toBeNull();
  });

  it('does not read a death out of a broadcast that did not advance the day', async () => {
    const { roomClient, rerender } = renderDay();

    // The same day, re-broadcast with a dead recruit. Nobody died overnight
    // here, because no night happened: only a day boundary can kill.
    rerender(<SurvivalDay
      room={room()}
      state={survivalState({
        stateId: 'survival:ABC234:70000:again',
        households: [{
          ...survivalState().households[0]!,
          characters: [character(), { ...recruit, isAlive: false }],
        }],
      })}
      readiness={readinessState()}
      user={user}
      connection="CONNECTED"
      roomClient={roomClient}
      onLeave={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Gort' }).hasAttribute('disabled')).toBe(true));
    expect(screen.queryByText(/did not survive the night/)).toBeNull();
  });

  it('clears yesterday’s outcome when the server opens the next day', async () => {
    const { roomClient, rerender } = renderDay();

    await userEvent.click(screen.getByRole('button', { name: `Feed Canned Soup to ${user.username}` }));
    expect(await screen.findByText(`Fed Canned Soup to ${user.username}.`)).toBeTruthy();

    const nextDayStartedAtMs = DAY_ENDS_AT_MS;
    rerender(<SurvivalDay
      room={room({ serverTimeMs: nextDayStartedAtMs, phaseEndsAtMs: nextDayStartedAtMs + GAME.survivalDurationMs })}
      state={survivalState({ dayNumber: 2, startedAtMs: nextDayStartedAtMs })}
      readiness={readinessState({
        dayNumber: 2,
        startedAtMs: nextDayStartedAtMs,
        endsAtMs: nextDayStartedAtMs + GAME.survivalDurationMs,
      })}
      user={user}
      connection="CONNECTED"
      roomClient={roomClient}
      onLeave={vi.fn()}
    />);

    await waitFor(() => expect(screen.queryByText(`Fed Canned Soup to ${user.username}.`)).toBeNull());
    expect(screen.getByText(/Day 2\./)).toBeTruthy();
    // The new day carries its own fresh window, not the one that just closed.
    expect(screen.getByRole('timer').textContent).toBe('2:00');
  });

  it('reports a dropped connection rather than pretending the feed landed', async () => {
    const consumeItem = vi.fn().mockRejectedValue(
      new RoomClientError('INTERNAL_ERROR', 'The match server did not acknowledge the feed', true),
    );
    renderDay({ roomClient: clientStub({ consumeItem }) });

    await userEvent.click(screen.getByRole('button', { name: `Feed Canned Soup to ${user.username}` }));

    expect(await screen.findByText('The match server did not acknowledge the feed')).toBeTruthy();
  });
});

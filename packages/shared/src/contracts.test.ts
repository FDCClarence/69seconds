import { describe, expect, it } from 'vitest';
import {
  CLIENT_EVENTS,
  GAME,
  SERVER_EVENTS,
  SURVIVAL_CHARACTER_DEFAULTS,
  canCarryItem,
  clientInputSchema,
  loginRequestSchema,
  matchTallySchema,
  registerRequestSchema,
  gameSnapshotSchema,
  interactionRequestSchema,
  interactionResultSchema,
  lootUpdateSchema,
  gamePhaseSchema,
  normalizeMovementVector,
  roomCodeSchema,
  roomCommandResultSchema,
  survivalStateSchema,
} from './index.js';

describe('shared contracts', () => {
  it('accepts a valid authoritative snapshot', () => {
    const snapshot = gameSnapshotSchema.parse({
      sequence: 1,
      roomCode: 'ABC234',
      phase: 'LOBBY',
      serverTimeMs: 1_000,
      phaseEndsAtMs: null,
      players: [{
        id: 'player-1', position: { x: 900, y: 600 }, sprinting: false,
        stamina: 100, exhausted: false, recoveringUntilMs: null,
        acknowledgedInputSequence: 4,
      }],
    });
    expect(snapshot.phase).toBe('LOBBY');
  });

  it('carries the survival phase and its one authoritative duration', () => {
    expect(gamePhaseSchema.parse('SURVIVAL')).toBe('SURVIVAL');
    expect(gamePhaseSchema.options).toContain('SURVIVAL');
    expect(() => gamePhaseSchema.parse('SURVIVE')).toThrow();
    // The survival day's length lives here alone, so the client countdown and the
    // server deadline can never disagree about it.
    expect(GAME.survivalDurationMs).toBe(120_000);
  });

  it('accepts a survival snapshot carrying the server-owned day deadline', () => {
    const snapshot = gameSnapshotSchema.parse({
      sequence: 2,
      roomCode: 'ABC234',
      phase: 'SURVIVAL',
      serverTimeMs: 70_000,
      phaseEndsAtMs: 70_000 + GAME.survivalDurationMs,
      players: [{
        id: 'player-1', position: { x: 900, y: 600 }, sprinting: false,
        stamina: 100, exhausted: false, recoveringUntilMs: null,
        acknowledgedInputSequence: 4,
      }],
    });
    expect(snapshot).toMatchObject({ phase: 'SURVIVAL', phaseEndsAtMs: 190_000 });
  });

  it('normalizes readable room codes and validates typed command results', () => {
    expect(roomCodeSchema.parse(' ab2cd3 ')).toBe('AB2CD3');
    expect(() => roomCodeSchema.parse('ABC10O')).toThrow();
    const result = roomCommandResultSchema.parse({
      ok: false,
      error: {
        code: 'ROOM_FULL',
        message: 'The room is full',
        event: 'room:join',
        retryable: false,
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects contradictory movement payload shapes', () => {
    expect(() => clientInputSchema.parse({ sequence: 1 })).toThrow();
    expect(() => clientInputSchema.parse({
      sequence: 1,
      clientTimeMs: 1,
      movement: { up: false, down: false, left: false, right: true },
      sprint: false,
      position: { x: 999_999, y: 999_999 },
    })).toThrow();
  });

  it('rejects an interaction request that claims its own outcome', () => {
    const requestId = '3f1c2c9a-5d2b-4a11-8f6e-9c0d1a2b3c4d';
    expect(interactionRequestSchema.parse({ requestId, action: 'INTERACT' }))
      .toEqual({ requestId, action: 'INTERACT' });
    expect(interactionRequestSchema.parse({ requestId, action: 'PICK_UP', targetId: 'loot-milk' }).targetId)
      .toBe('loot-milk');
    expect(() => interactionRequestSchema.parse({
      requestId,
      action: 'PICK_UP',
      targetId: 'loot-milk',
      outcome: 'PICKED_UP',
    })).toThrow();
    expect(() => interactionRequestSchema.parse({
      requestId,
      action: 'DROP_OFF',
      targetId: 'cart-0',
      carriedItemIds: ['loot-milk', 'loot-bread'],
    })).toThrow();
    expect(() => interactionRequestSchema.parse({ requestId: 'not-a-uuid', action: 'INTERACT' })).toThrow();
  });

  it('acknowledges every interaction with the requester\'s authoritative hands', () => {
    const requestId = '3f1c2c9a-5d2b-4a11-8f6e-9c0d1a2b3c4d';
    const rejected = interactionResultSchema.parse({
      outcome: 'REJECTED',
      requestId,
      reason: 'HANDS_FULL',
      message: 'Hands full',
      carriedItemIds: ['a', 'b', 'c', 'd'],
    });
    expect(rejected.carriedItemIds).toHaveLength(GAME.maxCarriedItems);
    expect(() => interactionResultSchema.parse({
      outcome: 'PICKED_UP',
      requestId,
      itemId: 'loot-milk',
      catalogId: 'bottled-water',
      carriedItemIds: ['a', 'b', 'c', 'd', 'e'],
    })).toThrow();
  });

  it('keeps broadcast loot updates free of private inventory contents', () => {
    const update = lootUpdateSchema.parse({
      type: 'PICKED_UP',
      sequence: 3,
      roomCode: 'ABC234',
      playerId: 'player-1',
      itemId: 'loot-milk',
      carriedCount: 2,
    });
    expect(update).not.toHaveProperty('carriedItemIds');
    expect(() => lootUpdateSchema.parse({
      type: 'PICKED_UP',
      sequence: 3,
      roomCode: 'ABC234',
      playerId: 'player-1',
      itemId: 'loot-milk',
      carriedCount: 2,
      carriedItemIds: ['loot-milk'],
    })).toThrow();
  });

  it('validates a complete server-owned tally and rejects a non-69-second result', () => {
    const tally = matchTallySchema.parse({
      resultId: 'ABC234:70000',
      roomCode: 'ABC234',
      lootingStartedAtMs: 1_000,
      lootingEndedAtMs: 70_000,
      durationMs: GAME.lootingDurationMs,
      totalItems: 1,
      categoryTotals: [{ category: 'food', count: 1 }],
      players: [{
        playerId: 'player-1',
        displayName: 'Player 1',
        slot: 0,
        isConnectedAtEnd: true,
        totalItems: 1,
        categoryTotals: [{ category: 'food', count: 1 }],
        items: [{ id: 'loot-water', catalogId: 'bottled-water', label: 'Bottled Water', category: 'food' }],
      }],
    });
    expect(tally.players[0]?.items[0]?.label).toBe('Bottled Water');
    expect(() => matchTallySchema.parse({ ...tally, durationMs: 68_000 })).toThrow();
    expect(() => matchTallySchema.parse({ ...tally, clientComputedWinner: 'player-1' })).toThrow();
  });

  it('enforces carry capacity and normalized movement', () => {
    expect(canCarryItem(GAME.maxCarriedItems)).toBe(false);
    expect(normalizeMovementVector({ x: 1, y: 1 }).x).toBeCloseTo(Math.SQRT1_2);
  });

  it('normalizes auth credentials and strictly validates auth bodies', () => {
    const registration = registerRequestSchema.parse({
      username: '  Cart_Goblin ',
      email: ' PLAYER@Example.COM ',
      password: 'a-long-password',
    });
    expect(registration).toMatchObject({ username: 'cart_goblin', email: 'player@example.com' });
    expect(registerRequestSchema.parse({
      username: 'easy',
      email: 'easy@example.com',
      password: 'password',
    })).toMatchObject({ username: 'easy', password: 'password' });
    expect(() => registerRequestSchema.parse({
      username: 'abc',
      email: 'player@example.com',
      password: 'password',
    })).toThrow();
    expect(() => registerRequestSchema.parse({
      username: 'player',
      email: 'player@example.com',
      password: 'short',
    })).toThrow();
    expect(() => registerRequestSchema.parse({
      username: 'no spaces',
      email: 'player@example.com',
      password: 'a-long-password',
    })).toThrow();
    expect(loginRequestSchema.parse({ identifier: ' Cart_Goblin ', password: 'password' }).identifier).toBe('cart_goblin');
    expect(() => loginRequestSchema.parse({
      identifier: 'player@example.com',
      password: 'password',
      unexpected: true,
    })).toThrow();
  });

  it('carries the survival households one way only', () => {
    // Server to client, and nowhere in the other direction: there is no client
    // event through which stats, maxes, daily costs, or alive state could be
    // submitted.
    expect(Object.values(SERVER_EVENTS)).toContain('survival:state');
    expect(Object.values(CLIENT_EVENTS)).not.toContain('survival:state');
    for (const event of Object.values(CLIENT_EVENTS)) {
      expect(event).not.toMatch(/survival/);
    }
  });

  it('accepts a household whose recruit has their own maxes and daily costs', () => {
    const state = survivalStateSchema.parse({
      stateId: 'survival:ABC234:71000',
      roomCode: 'ABC234',
      dayNumber: 1,
      startedAtMs: 71_000,
      households: [{
        playerId: 'player-1',
        displayName: 'Player 1',
        slot: 0,
        characters: [{
          id: 'player-1',
          displayName: 'Player 1',
          kind: 'MAIN',
          catalogId: null,
          isAlive: true,
          stats: SURVIVAL_CHARACTER_DEFAULTS.stats,
          dailyNutritionCost: 20,
          dailyHydrationCost: 20,
        }, {
          id: 'loot-spot-01',
          displayName: 'Maya',
          kind: 'NPC',
          catalogId: 'maya',
          isAlive: true,
          stats: { ...SURVIVAL_CHARACTER_DEFAULTS.stats, health: { current: 120, max: 120 } },
          dailyNutritionCost: 20,
          dailyHydrationCost: 30,
        }],
        inventory: [{ id: 'loot-spot-02', catalogId: 'canned-soup', label: 'Canned Soup', category: 'food' }],
      }],
    });
    expect(state.households[0]?.characters[1]?.stats.health.max).toBe(120);
    expect(state.households[0]?.characters[1]?.dailyHydrationCost).toBe(30);
  });

  it('rejects survival state no server would produce', () => {
    const base = survivalStateSchema.parse({
      stateId: 'survival:ABC234:71000',
      roomCode: 'ABC234',
      dayNumber: 1,
      startedAtMs: 71_000,
      households: [{
        playerId: 'player-1',
        displayName: 'Player 1',
        slot: 0,
        characters: [{
          id: 'player-1',
          displayName: 'Player 1',
          kind: 'MAIN',
          catalogId: null,
          isAlive: true,
          stats: SURVIVAL_CHARACTER_DEFAULTS.stats,
          dailyNutritionCost: 20,
          dailyHydrationCost: 20,
        }],
        inventory: [],
      }],
    });
    const withCharacter = (overrides: Record<string, unknown>) => ({
      ...base,
      households: [{
        ...base.households[0],
        characters: [{ ...base.households[0]?.characters[0], ...overrides }],
      }],
    });
    // A stat above its own max, a max of zero, a negative daily cost, a main
    // character claiming a catalog entry, and a household with nobody in it.
    expect(() => survivalStateSchema.parse(withCharacter({
      stats: { ...SURVIVAL_CHARACTER_DEFAULTS.stats, nutrition: { current: 101, max: 100 } },
    }))).toThrow();
    expect(() => survivalStateSchema.parse(withCharacter({
      stats: { ...SURVIVAL_CHARACTER_DEFAULTS.stats, health: { current: 0, max: 0 } },
    }))).toThrow();
    expect(() => survivalStateSchema.parse(withCharacter({ dailyHydrationCost: -1 }))).toThrow();
    expect(() => survivalStateSchema.parse(withCharacter({ catalogId: 'maya' }))).toThrow();
    expect(() => survivalStateSchema.parse(withCharacter({ unexpected: true }))).toThrow();
    expect(() => survivalStateSchema.parse({
      ...base,
      households: [{ ...base.households[0], characters: [] }],
    })).toThrow();
    // A day before the first, or a fraction of one: looting precedes Day 1, so
    // there is no Day 0 and no half day.
    for (const dayNumber of [0, -1, 1.5]) {
      expect(() => survivalStateSchema.parse({ ...base, dayNumber })).toThrow();
    }
    expect(survivalStateSchema.parse({ ...base, dayNumber: 2 }).dayNumber).toBe(2);
  });
});

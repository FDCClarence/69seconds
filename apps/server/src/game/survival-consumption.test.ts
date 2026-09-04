import {
  SURVIVAL,
  SURVIVAL_CHARACTER_DEFAULTS,
  survivalStateSchema,
  type SurvivalConsumeRequest,
  type SurvivalState,
} from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import {
  SURVIVAL_CONSUME_REJECTION_MESSAGES,
  SurvivalConsumptionAuthority,
  type SurvivalDayActionStatus,
} from './survival-consumption.js';

function day(): SurvivalState {
  return survivalStateSchema.parse({
    stateId: 'survival:ABC234:71000',
    roomCode: 'ABC234',
    dayNumber: 1,
    startedAtMs: 71_000,
    households: [{
      playerId: 'player-0',
      displayName: 'Player 0',
      slot: 0,
      characters: [{
        id: 'player-0',
        displayName: 'Player 0',
        kind: 'MAIN',
        catalogId: null,
        isAlive: true,
        stats: {
          ...SURVIVAL_CHARACTER_DEFAULTS.stats,
          nutrition: { current: 20, max: 100 },
          hydration: { current: 30, max: 100 },
        },
        dailyNutritionCost: SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
        dailyHydrationCost: SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost,
      }],
      inventory: [
        { id: 'loot-soup', catalogId: 'canned-soup', label: 'Canned Soup', category: 'food' },
        { id: 'loot-water', catalogId: 'bottled-water', label: 'Bottled Water', category: 'food' },
      ],
    }],
  });
}

let requestCounter = 0;
function request(itemId: string, characterId = 'player-0'): SurvivalConsumeRequest {
  requestCounter += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestCounter).padStart(12, '0')}`,
    itemId,
    characterId,
  };
}

function feed(
  authority: SurvivalConsumptionAuthority,
  state: SurvivalState | null,
  consumeRequest: SurvivalConsumeRequest,
  dayActionStatus: SurvivalDayActionStatus = 'OPEN',
  playerId = 'player-0',
) {
  return authority.resolve({ playerId, request: consumeRequest, state, dayActionStatus });
}

describe('SurvivalConsumptionAuthority', () => {
  it('commits a feed and hands back the state the room should now hold', () => {
    const authority = new SurvivalConsumptionAuthority();
    const before = day();
    const resolution = feed(authority, before, request('loot-soup'));
    expect(resolution.replayed).toBe(false);
    expect(resolution.result).toMatchObject({ outcome: 'CONSUMED', itemId: 'loot-soup', catalogId: 'canned-soup' });
    if (resolution.result.outcome !== 'CONSUMED') throw new Error('Expected a committed feed');
    expect(resolution.result.character.stats.nutrition).toEqual({ current: 70, max: 100 });
    expect(resolution.result.inventory.map((item) => item.id)).toEqual(['loot-water']);
    expect(resolution.state?.households[0]?.inventory.map((item) => item.id)).toEqual(['loot-water']);
    expect(resolution.state).not.toBe(before);
  });

  it('replays a duplicate request ID without spending a second item', () => {
    const authority = new SurvivalConsumptionAuthority();
    const state = day();
    const first = feed(authority, state, request('loot-soup'));
    if (first.result.outcome !== 'CONSUMED') throw new Error('Expected a committed feed');
    const committed = first.state!;

    // The same request ID arriving again against the state it already produced:
    // the item is gone, but the decision is replayed rather than re-judged.
    const repeated = feed(authority, committed, {
      requestId: first.result.requestId,
      itemId: 'loot-soup',
      characterId: 'player-0',
    });
    expect(repeated.replayed).toBe(true);
    expect(repeated.result).toEqual(first.result);
    // Nothing to broadcast and nothing to commit: the day is untouched.
    expect(repeated.state).toBeNull();
    expect(committed.households[0]?.inventory.map((item) => item.id)).toEqual(['loot-water']);
    // A replay is not a licence to eat twice: the character stands where the
    // single committed feed left them.
    expect(committed.households[0]?.characters[0]?.stats.nutrition).toEqual({ current: 70, max: 100 });
  });

  it('replays a committed feed even after that household ended its day', () => {
    const authority = new SurvivalConsumptionAuthority();
    const first = feed(authority, day(), request('loot-soup'));
    if (first.result.outcome !== 'CONSUMED') throw new Error('Expected a committed feed');
    // A delayed duplicate of a feed that already happened is still that feed. It
    // reports what it did rather than being refused for a gate it beat.
    const late = feed(authority, first.state, {
      requestId: first.result.requestId,
      itemId: 'loot-soup',
      characterId: 'player-0',
    }, 'ALREADY_ENDED');
    expect(late).toEqual({ result: first.result, state: null, replayed: true });
  });

  it('keeps each household\'s ledger to itself', () => {
    const authority = new SurvivalConsumptionAuthority();
    const first = feed(authority, day(), request('loot-soup'));
    if (first.result.outcome !== 'CONSUMED') throw new Error('Expected a committed feed');
    // Another player reusing that request ID gets judged, not handed somebody
    // else's committed decision.
    const borrowed = feed(authority, first.state, {
      requestId: first.result.requestId,
      itemId: 'loot-water',
      characterId: 'player-0',
    }, 'OPEN', 'player-1');
    expect(borrowed.replayed).toBe(false);
    expect(borrowed.result).toMatchObject({ outcome: 'REJECTED', reason: 'NO_HOUSEHOLD' });
  });

  it('refuses a household that has already ended its day', () => {
    const authority = new SurvivalConsumptionAuthority();
    const state = day();
    const resolution = feed(authority, state, request('loot-soup'), 'ALREADY_ENDED');
    expect(resolution.result).toMatchObject({
      outcome: 'REJECTED',
      reason: 'DAY_ALREADY_ENDED',
      message: SURVIVAL_CONSUME_REJECTION_MESSAGES.DAY_ALREADY_ENDED,
    });
    expect(resolution.state).toBeNull();
    expect(state.households[0]?.inventory).toHaveLength(2);
  });

  it('refuses a day that is over, a household that does not exist, and a room with no day', () => {
    const authority = new SurvivalConsumptionAuthority();
    expect(feed(authority, day(), request('loot-soup'), 'DAY_CLOSED').result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
    expect(feed(authority, day(), request('loot-soup'), 'NOT_A_HOUSEHOLD').result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'NO_HOUSEHOLD' });
    // No committed day at all — before the buzzer, or in a room that never had one.
    expect(feed(authority, null, request('loot-soup')).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
  });

  it('does not remember a rejection, so a legitimate retry is judged afresh', () => {
    const authority = new SurvivalConsumptionAuthority();
    const state = day();
    const refused = request('loot-soup');
    expect(feed(authority, state, refused, 'ALREADY_ENDED').result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'DAY_ALREADY_ENDED' });

    // The same request ID, once the day is open again: it is a feed, not a
    // replayed refusal.
    const retried = feed(authority, state, refused, 'OPEN');
    expect(retried.replayed).toBe(false);
    expect(retried.result).toMatchObject({ outcome: 'CONSUMED', itemId: 'loot-soup' });
  });

  it('carries a distinct message for every rejection a client can be handed', () => {
    const messages = Object.values(SURVIVAL_CONSUME_REJECTION_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
  });

  it('drops a departed household\'s ledger with them', () => {
    const authority = new SurvivalConsumptionAuthority();
    const first = feed(authority, day(), request('loot-soup'));
    if (first.result.outcome !== 'CONSUMED') throw new Error('Expected a committed feed');
    authority.forgetPlayer('player-0');
    // Nothing replays for somebody the match no longer has; the request is
    // judged against the state as it now stands, where the soup is gone.
    const afterLeaving = feed(authority, first.state, {
      requestId: first.result.requestId,
      itemId: 'loot-soup',
      characterId: 'player-0',
    });
    expect(afterLeaving.replayed).toBe(false);
    expect(afterLeaving.result).toMatchObject({ outcome: 'REJECTED', reason: 'UNKNOWN_ITEM' });
  });

  it('remembers every feed a household could make in a match', () => {
    // The ledger is bounded, and the bound is deliberately above the largest
    // inventory a household can hold, so no feed made this match ages out of it
    // while a duplicate of it could still arrive.
    expect(SURVIVAL.consumptionHistorySize).toBeGreaterThanOrEqual(256);
    const authority = new SurvivalConsumptionAuthority();
    const meals = 60;
    let state = survivalStateSchema.parse({
      ...day(),
      households: [{
        ...day().households[0]!,
        inventory: Array.from({ length: meals }, (_, index) => ({
          id: `loot-soup-${index}`,
          catalogId: 'canned-soup',
          label: 'Canned Soup',
          category: 'food' as const,
        })),
      }],
    });
    const first = feed(authority, state, request('loot-soup-0'));
    if (first.result.outcome !== 'CONSUMED') throw new Error('Expected a committed feed');
    state = first.state!;
    for (let index = 1; index < meals; index += 1) {
      const next = feed(authority, state, request(`loot-soup-${index}`));
      if (next.result.outcome !== 'CONSUMED') throw new Error('Expected a committed feed');
      state = next.state!;
    }
    expect(state.households[0]?.inventory).toEqual([]);
    // The very first decision still replays, dozens of meals later.
    const replayed = feed(authority, state, {
      requestId: first.result.requestId,
      itemId: 'loot-soup-0',
      characterId: 'player-0',
    });
    expect(replayed).toEqual({ result: first.result, state: null, replayed: true });
  });
});

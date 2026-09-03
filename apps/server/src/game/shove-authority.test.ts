import {
  SHOVE,
  distanceBetween,
  isValidPlayerPosition,
  type CollisionRectangle,
  type ShoveRequest,
  type Vector2,
} from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import {
  MatchShoveAuthority,
  type ShoveAuthorityOptions,
  type ShoveContext,
  type ShoveParticipant,
} from './shove-authority.js';

const EAST: Vector2 = { x: 1, y: 0 };
const SHOVER = { x: 900, y: 550 };
/** Well inside the shove range, directly along an eastward facing. */
const IN_FRONT = { x: 940, y: 550 };

let requestCounter = 0;
function request(overrides: Partial<ShoveRequest> = {}): ShoveRequest {
  requestCounter += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestCounter).padStart(12, '0')}`,
    ...overrides,
  };
}

function participant(
  id: string,
  position: Vector2,
  overrides: Partial<ShoveParticipant> = {},
): ShoveParticipant {
  return { id, position, facing: { ...EAST }, recoveringUntilMs: 0, eligible: true, ...overrides };
}

function context(
  participants: readonly ShoveParticipant[],
  overrides: Partial<ShoveContext> = {},
): ShoveContext {
  return {
    shoverId: 'shover',
    participants,
    phase: 'LOOTING',
    phaseEndsAtMs: 100_000,
    serverNowMs: 10_000,
    request: request(),
    ...overrides,
  };
}

function authority(options: ShoveAuthorityOptions = {}): MatchShoveAuthority {
  return new MatchShoveAuthority('ABC234', options);
}

const PAIR = [participant('shover', SHOVER), participant('target', IN_FRONT)];

describe('authoritative shove decisions', () => {
  it('lands on a nominated target in range and in front, and starts the cooldown', () => {
    const shoves = authority();
    const resolution = shoves.resolve(context(PAIR, { request: request({ targetPlayerId: 'target' }) }));

    expect(resolution.result).toMatchObject({ outcome: 'LANDED', targetPlayerId: 'target' });
    expect(resolution.result.cooldownEndsAtMs).toBe(10_000 + SHOVE.cooldownMs);
    expect(resolution.effect).toMatchObject({
      targetPlayerId: 'target',
      recoveryEndsAtMs: 10_000 + SHOVE.recoveryMs,
    });
    // Open floor east of the store centre, so the full push applies.
    expect(distanceBetween(IN_FRONT, resolution.effect!.position)).toBeCloseTo(SHOVE.knockbackPixels);
    expect(isValidPlayerPosition(resolution.effect!.position)).toBe(true);
    expect(resolution.landed).toMatchObject({
      roomCode: 'ABC234',
      shoverPlayerId: 'shover',
      targetPlayerId: 'target',
      direction: { x: 1, y: 0 },
    });
  });

  it('refuses a target beyond the configured range', () => {
    const far = [participant('shover', SHOVER), participant('target', { x: SHOVER.x + SHOVE.rangePixels + 2, y: 550 })];
    const resolution = authority().resolve(context(far, { request: request({ targetPlayerId: 'target' }) }));
    expect(resolution.result).toMatchObject({ outcome: 'REJECTED', reason: 'OUT_OF_RANGE' });
    expect(resolution.effect).toBeNull();
  });

  it('refuses a target outside the facing cone', () => {
    const beside = [participant('shover', SHOVER), participant('target', { x: 900, y: 610 })];
    const resolution = authority().resolve(context(beside, { request: request({ targetPlayerId: 'target' }) }));
    expect(resolution.result).toMatchObject({ outcome: 'REJECTED', reason: 'OUT_OF_CONE' });
  });

  it('refuses to reach through blocking geometry', () => {
    // Production shelves are thicker than the shove range, so a purpose-built
    // divider is the only way to sit two players on opposite sides of one.
    const divider: CollisionRectangle = { id: 'test-divider', x: 920, y: 550, width: 8, height: 200 };
    const resolution = authority({ collision: [divider] })
      .resolve(context(PAIR, { request: request({ targetPlayerId: 'target' }) }));
    expect(resolution.result).toMatchObject({ outcome: 'REJECTED', reason: 'NO_LINE_OF_ACCESS' });
  });

  it('refuses self-targeting, unknown players, and ineligible players', () => {
    const shoves = authority();
    expect(shoves.resolve(context(PAIR, { request: request({ targetPlayerId: 'shover' }) })).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'SELF_TARGET' });
    expect(shoves.resolve(context(PAIR, { request: request({ targetPlayerId: 'ghost' }) })).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'UNKNOWN_TARGET' });

    const reconnecting = [participant('shover', SHOVER), participant('target', IN_FRONT, { eligible: false })];
    expect(authority().resolve(context(reconnecting, { request: request({ targetPlayerId: 'target' }) })).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'TARGET_UNAVAILABLE' });
  });

  it('chooses the nearest reachable player when the request nominates nobody', () => {
    const crowd = [
      participant('shover', SHOVER),
      participant('behind', { x: 860, y: 550 }),
      participant('far-ahead', { x: 970, y: 550 }),
      participant('near-ahead', { x: 930, y: 550 }),
      participant('ahead-but-gone', { x: 925, y: 550 }, { eligible: false }),
    ];
    const resolution = authority().resolve(context(crowd));
    expect(resolution.result).toMatchObject({ outcome: 'LANDED', targetPlayerId: 'near-ahead' });
  });

  it('reports an empty cone rather than reaching behind the shover', () => {
    const onlyBehind = [participant('shover', SHOVER), participant('target', { x: 860, y: 550 })];
    expect(authority().resolve(context(onlyBehind)).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'NO_TARGET_IN_CONE' });
  });

  it('enforces the cooldown and reports when it expires', () => {
    const shoves = authority();
    const first = shoves.resolve(context(PAIR, { request: request({ targetPlayerId: 'target' }) }));
    expect(first.result.outcome).toBe('LANDED');

    const tooSoon = shoves.resolve(context(PAIR, {
      request: request({ targetPlayerId: 'target' }),
      serverNowMs: 10_000 + SHOVE.cooldownMs - 1,
    }));
    expect(tooSoon.result).toMatchObject({ outcome: 'REJECTED', reason: 'ON_COOLDOWN' });
    expect(tooSoon.result.cooldownEndsAtMs).toBe(10_000 + SHOVE.cooldownMs);

    const afterwards = shoves.resolve(context(PAIR, {
      request: request({ targetPlayerId: 'target' }),
      serverNowMs: 10_000 + SHOVE.cooldownMs,
    }));
    expect(afterwards.result.outcome).toBe('LANDED');
  });

  it('resolves a mutual exchange to a single winner by arrival order', () => {
    const shoves = authority();
    const first = shoves.resolve(context(PAIR, {
      shoverId: 'shover',
      request: request({ targetPlayerId: 'target' }),
    }));
    expect(first.result.outcome).toBe('LANDED');

    // The simulation applies the recovery window before the next request is read.
    const afterFirst = [
      participant('shover', SHOVER),
      participant('target', first.effect!.position, { recoveringUntilMs: first.effect!.recoveryEndsAtMs }),
    ];
    const retaliation = shoves.resolve(context(afterFirst, {
      shoverId: 'target',
      request: request({ targetPlayerId: 'shover' }),
    }));
    expect(retaliation.result).toMatchObject({ outcome: 'REJECTED', reason: 'RECOVERING' });
    expect(retaliation.effect).toBeNull();
  });

  it('rate-limits a spammed burst without blocking cooldown-paced play', () => {
    const shoves = authority();
    const outcomes = Array.from({ length: SHOVE.burstCapacity + 2 }, () => shoves.resolve(context(PAIR, {
      request: request({ targetPlayerId: 'target' }),
    })).result);

    expect(outcomes[0]).toMatchObject({ outcome: 'LANDED' });
    // The burst is spent on cooldown rejections, then the limiter takes over.
    expect(outcomes.slice(1, SHOVE.burstCapacity).every((result) => result.outcome === 'REJECTED')).toBe(true);
    for (const limited of outcomes.slice(SHOVE.burstCapacity)) {
      expect(limited).toMatchObject({ outcome: 'REJECTED', reason: 'RATE_LIMITED' });
    }

    // A player who respects the cooldown never meets the limiter.
    const paced = authority();
    for (let shove = 0; shove < 8; shove += 1) {
      const result = paced.resolve(context(PAIR, {
        request: request({ targetPlayerId: 'target' }),
        serverNowMs: 10_000 + shove * SHOVE.cooldownMs,
      })).result;
      expect(result.outcome).toBe('LANDED');
    }
  });

  it('replays a duplicate request instead of shoving twice', () => {
    const shoves = authority();
    const duplicate = request({ targetPlayerId: 'target' });
    const first = shoves.resolve(context(PAIR, { request: duplicate }));
    const replay = shoves.resolve(context(PAIR, { request: duplicate }));

    expect(first.result.outcome).toBe('LANDED');
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(replay.effect).toBeNull();
    expect(replay.landed).toBeNull();
  });

  it('retains replay protection for every cooldown-paced shove in one match', () => {
    const shoves = authority();
    const firstRequest = request({ targetPlayerId: 'target' });
    const first = shoves.resolve(context(PAIR, { request: firstRequest }));
    expect(first.result.outcome).toBe('LANDED');

    // Forty later commits exceed the old 32-entry cache while remaining inside
    // the fixed 69-second looting window and respecting every cooldown.
    for (let index = 1; index <= 40; index += 1) {
      const resolution = shoves.resolve(context(PAIR, {
        request: request({ targetPlayerId: 'target' }),
        serverNowMs: 10_000 + index * SHOVE.cooldownMs,
      }));
      expect(resolution.result.outcome).toBe('LANDED');
    }

    const replay = shoves.resolve(context(PAIR, {
      request: firstRequest,
      serverNowMs: 10_000 + 41 * SHOVE.cooldownMs,
    }));
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(replay.landed).toBeNull();
  });

  it('closes shoving outside the looting window', () => {
    const shoves = authority();
    expect(shoves.resolve(context(PAIR, {
      phase: 'COUNTDOWN',
      request: request({ targetPlayerId: 'target' }),
    })).result).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });

    expect(shoves.resolve(context(PAIR, {
      serverNowMs: 100_001,
      request: request({ targetPlayerId: 'target' }),
    })).result).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
  });

  it('refuses a shover who is not in the match', () => {
    expect(authority().resolve(context([participant('target', IN_FRONT)])).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'NOT_IN_MATCH', cooldownEndsAtMs: 0 });
  });

  it('pushes away from the shover rather than along the facing', () => {
    // Target sits at the edge of the cone, so facing and push visibly differ.
    const diagonal = [participant('shover', SHOVER), participant('target', { x: 930, y: 590 })];
    const resolution = authority().resolve(context(diagonal, { request: request({ targetPlayerId: 'target' }) }));
    expect(resolution.result.outcome).toBe('LANDED');
    expect(resolution.landed!.direction.y).toBeGreaterThan(0);
    expect(resolution.effect!.position.y).toBeGreaterThan(590);
  });

  it('shortens the push against geometry and reports the distance actually applied', () => {
    // Directly below a shelf column, shoved north into it.
    const pinned = [
      participant('shover', { x: 300, y: 600 }, { facing: { x: 0, y: -1 } }),
      participant('target', { x: 300, y: 550 }),
    ];
    const resolution = authority().resolve(context(pinned, { request: request({ targetPlayerId: 'target' }) }));
    expect(resolution.result.outcome).toBe('LANDED');
    expect(resolution.landed!.knockbackPixels).toBeGreaterThan(0);
    expect(resolution.landed!.knockbackPixels).toBeLessThan(SHOVE.knockbackPixels);
    expect(isValidPlayerPosition(resolution.effect!.position)).toBe(true);
  });
});

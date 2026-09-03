import {
  GAME,
  NETWORK,
  PLAYER_SPAWN_POSITIONS,
  SHOVE,
  SPRINT,
  distanceBetween,
  isValidPlayerPosition,
  simulatePlayerMovement,
  type ClientInput,
  type RoomPublicState,
  type ShoveRequest,
} from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import { AuthoritativeRoomSimulation } from './simulation.js';

function room(playerCount = 1): RoomPublicState {
  return {
    code: 'ABC234',
    phase: 'COUNTDOWN',
    hostPlayerId: 'player-0',
    players: Array.from({ length: playerCount }, (_, slot) => ({
      id: `player-${slot}`,
      displayName: `Player ${slot}`,
      slot,
      isHost: slot === 0,
      isReady: true,
      isConnected: true,
      connectionState: 'CONNECTED' as const,
      position: { ...PLAYER_SPAWN_POSITIONS[slot]! },
    })),
    serverTimeMs: 1_000,
    phaseEndsAtMs: 2_000,
  };
}

function input(sequence: number, overrides: Partial<ClientInput> = {}): ClientInput {
  return {
    sequence,
    clientTimeMs: 0,
    movement: { up: false, down: false, left: false, right: true },
    sprint: false,
    ...overrides,
  };
}

/** Two players 40px apart on the open floor east of the store centre, inside shove range. */
function adjacentRoom(): RoomPublicState {
  const base = room(2);
  base.players[0]!.position = { x: 900, y: 550 };
  base.players[1]!.position = { x: 940, y: 550 };
  return base;
}

const LEFT = { up: false, down: false, left: true, right: false };

let shoveCounter = 0;
function shove(targetPlayerId?: string): ShoveRequest {
  shoveCounter += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(shoveCounter).padStart(12, '0')}`,
    ...(targetPlayerId ? { targetPlayerId } : {}),
  };
}

function playerIn(simulation: AuthoritativeRoomSimulation, serverNowMs: number, playerId: string) {
  return simulation.snapshot(serverNowMs).players.find((player) => player.id === playerId)!;
}

describe('authoritative movement simulation', () => {
  it('gates movement during countdown, then acknowledges ordered inputs', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    expect(simulation.submitInput('player-0', input(2))).toBe(true);
    expect(simulation.submitInput('player-0', input(1))).toBe(false);
    simulation.tick(1_500);
    expect(simulation.snapshot(1_500).players[0]).toMatchObject({
      position: PLAYER_SPAWN_POSITIONS[0],
      acknowledgedInputSequence: 2,
    });

    simulation.submitInput('player-0', input(3));
    simulation.tick(2_000);
    const snapshot = simulation.snapshot(2_000);
    expect(snapshot.phase).toBe('LOOTING');
    expect(snapshot.players[0]!.position.x).toBeCloseTo(
      PLAYER_SPAWN_POSITIONS[0]!.x + GAME.walkSpeedPixelsPerSecond / NETWORK.simulationTickRateHz,
    );
    expect(snapshot.players[0]!.acknowledgedInputSequence).toBe(3);
  });

  it('derives sprint speed from validated input and cannot exceed the configured step', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    simulation.submitInput('player-0', input(0, { sprint: true }));
    simulation.tick(2_000);
    const position = simulation.snapshot(2_000).players[0]!.position;
    expect(position.x - PLAYER_SPAWN_POSITIONS[0]!.x).toBeCloseTo(
      GAME.sprintSpeedPixelsPerSecond / NETWORK.simulationTickRateHz,
    );
    expect(position.x - PLAYER_SPAWN_POSITIONS[0]!.x).toBeLessThan(8);
  });

  it('blocks shared shelf collision and map boundary crossing', () => {
    const againstShelf = simulatePlayerMovement(
      { x: 150, y: 260 },
      { up: false, down: false, left: false, right: true },
      true,
      1 / NETWORK.simulationTickRateHz,
    );
    expect(againstShelf).toEqual({ x: 150, y: 260 });
    expect(isValidPlayerPosition(againstShelf)).toBe(true);

    const againstBoundary = simulatePlayerMovement(
      { x: GAME.playerCollisionRadiusPixels, y: 900 },
      { up: false, down: false, left: true, right: false },
      true,
      1 / NETWORK.simulationTickRateHz,
    );
    expect(againstBoundary.x).toBe(GAME.playerCollisionRadiusPixels);
  });

  it('simulates four distinct players without overlapping spawns', () => {
    const simulation = new AuthoritativeRoomSimulation(room(4));
    for (let index = 0; index < 4; index += 1) {
      simulation.submitInput(`player-${index}`, input(0, {
        movement: { up: index === 0, down: index === 1, left: index === 2, right: index === 3 },
      }));
    }
    simulation.tick(2_000);
    const players = simulation.snapshot(2_000).players;
    expect(new Set(players.map((player) => `${player.position.x}:${player.position.y}`)).size).toBe(4);
    for (let left = 0; left < players.length; left += 1) {
      for (let right = left + 1; right < players.length; right += 1) {
        expect(Math.hypot(
          players[left]!.position.x - players[right]!.position.x,
          players[left]!.position.y - players[right]!.position.y,
        )).toBeGreaterThan(GAME.playerCollisionRadiusPixels * 2);
      }
    }
  });

  it('resets held input and sequencing safely', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    simulation.submitInput('player-0', input(20, { sprint: true }));
    simulation.tick(2_000);
    const moved = simulation.snapshot(2_000).players[0]!.position.x;
    simulation.resetInput('player-0', true);
    simulation.tick(2_034);
    expect(simulation.snapshot(2_034).players[0]).toMatchObject({
      position: { x: moved },
      sprinting: false,
      acknowledgedInputSequence: -1,
    });
    expect(simulation.submitInput('player-0', input(0))).toBe(true);
  });

  it('stops stale held movement before transport disconnect detection', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    simulation.submitInput('player-0', input(0), 2_000);
    simulation.tick(2_000);
    const moved = playerIn(simulation, 2_000, 'player-0').position.x;

    simulation.tick(2_000 + NETWORK.inputIdleTimeoutMs);
    expect(playerIn(simulation, 2_000 + NETWORK.inputIdleTimeoutMs, 'player-0')).toMatchObject({
      position: { x: moved },
      sprinting: false,
    });
  });

  it('validates interactions against the position the simulation itself owns', () => {
    // An explicit spawn, because the production loot set is drawn at random per
    // match: the assertion below is about geometry, not about which item landed.
    const simulation = new AuthoritativeRoomSimulation(room(), {
      spawns: [{ id: 'loot-corner', catalogId: 'canned-soup', x: 150, y: 165 }],
    });
    const near = { requestId: '00000000-0000-4000-8000-000000000001', action: 'PICK_UP' as const, targetId: 'loot-corner' };

    // Still in COUNTDOWN: the phase gate closes before any geometry is considered.
    expect(simulation.resolveInteraction('player-0', near, 1_500).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });

    simulation.tick(2_000);
    // Spawn slot 0 is at the store centre, far from the corner item.
    expect(simulation.resolveInteraction('player-0', near, 2_000).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'OUT_OF_RANGE' });
    expect(simulation.lootSyncFor('player-0')).toMatchObject({
      roomCode: 'ABC234',
      carriedItemIds: [],
    });
  });

  it('schedules twenty compact snapshots per thirty fixed simulation ticks', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    let snapshots = 0;
    for (let tick = 0; tick < NETWORK.simulationTickRateHz; tick += 1) {
      if (simulation.tick(1_000 + tick).snapshotDue) snapshots += 1;
    }
    expect(snapshots).toBe(NETWORK.snapshotRateHz);
  });
});

describe('server-owned sprint resource', () => {
  it('spends the bar only while sprinting and reports it in the snapshot', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    simulation.submitInput('player-0', input(0, { sprint: true }));
    simulation.tick(2_000);
    const sprinting = playerIn(simulation, 2_000, 'player-0');
    expect(sprinting.sprinting).toBe(true);
    expect(sprinting.stamina).toBeLessThan(SPRINT.staminaCapacity);
    expect(sprinting.exhausted).toBe(false);

    // Shift held with no movement is not sprinting, so the bar climbs back.
    simulation.submitInput('player-0', input(1, {
      sprint: true,
      movement: { up: false, down: false, left: false, right: false },
    }));
    simulation.tick(2_034);
    const standing = playerIn(simulation, 2_034, 'player-0');
    expect(standing.sprinting).toBe(false);
    expect(standing.stamina).toBeGreaterThan(sprinting.stamina);
  });

  it('clears effective sprinting when the looting deadline closes', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    simulation.submitInput('player-0', input(0, { sprint: true }));
    simulation.tick(2_000);
    expect(playerIn(simulation, 2_000, 'player-0').sprinting).toBe(true);

    const lootingEndsAt = 2_000 + GAME.lootingDurationMs;
    simulation.tick(lootingEndsAt);
    expect(playerIn(simulation, lootingEndsAt, 'player-0').sprinting).toBe(false);
  });

  it('drops an exhausted player to walking speed instead of stopping them', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    simulation.tick(2_000);
    // Hold sprint until the bar first latches, alternating direction so the
    // player stays on open floor rather than pinning against the map edge. The
    // sample has to be taken here: keep holding and the latch clears again at
    // the re-engage floor.
    let exhausted = playerIn(simulation, 2_000, 'player-0');
    for (let tick = 0; tick < NETWORK.simulationTickRateHz * 30 && !exhausted.exhausted; tick += 1) {
      simulation.submitInput('player-0', input(tick + 1, {
        sprint: true,
        movement: tick % 60 < 30 ? { up: false, down: false, left: false, right: true } : LEFT,
      }));
      simulation.tick(2_000 + tick * 34);
      exhausted = playerIn(simulation, 2_000 + tick * 34, 'player-0');
    }
    expect(exhausted.exhausted).toBe(true);
    expect(exhausted.stamina).toBe(0);
    // The latching tick was itself a sprinting tick; denial starts on the next one.

    const before = exhausted.position.x;
    simulation.submitInput('player-0', input(100_000, { sprint: true }));
    simulation.tick(20_000);
    const stillWalking = playerIn(simulation, 20_000, 'player-0');
    expect(stillWalking.sprinting).toBe(false);
    expect(stillWalking.position.x - before).toBeCloseTo(
      GAME.walkSpeedPixelsPerSecond / NETWORK.simulationTickRateHz,
    );
  });

  it('cannot be refilled by dropping and restoring the socket', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    simulation.tick(2_000);
    for (let tick = 0; tick < 60; tick += 1) {
      simulation.submitInput('player-0', input(tick + 1, { sprint: true }));
      simulation.tick(2_000 + tick * 34);
    }
    const spent = playerIn(simulation, 4_100, 'player-0').stamina;
    expect(spent).toBeLessThan(SPRINT.staminaCapacity);

    simulation.resetInput('player-0', true);
    const afterReconnect = playerIn(simulation, 4_100, 'player-0');
    expect(afterReconnect.stamina).toBe(spent);
    expect(afterReconnect.sprinting).toBe(false);
  });
});

describe('authoritative shove effects', () => {
  it('aims along the facing the server derived from movement input', () => {
    const simulation = new AuthoritativeRoomSimulation(adjacentRoom());
    // Spawn facing is south, so the eastward neighbour is outside the cone.
    simulation.tick(2_000);
    expect(simulation.resolveShove('player-0', shove('player-1'), 2_000).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'OUT_OF_CONE' });

    simulation.submitInput('player-0', input(1));
    simulation.tick(2_034);
    expect(simulation.resolveShove('player-0', shove('player-1'), 2_034).result)
      .toMatchObject({ outcome: 'LANDED', targetPlayerId: 'player-1' });
  });

  it('moves the target to a legal position and freezes only its own input', () => {
    const simulation = new AuthoritativeRoomSimulation(adjacentRoom());
    simulation.submitInput('player-0', input(1));
    simulation.tick(2_000);
    const before = playerIn(simulation, 2_000, 'player-1').position;

    const resolution = simulation.resolveShove('player-0', shove('player-1'), 2_000);
    expect(resolution.result.outcome).toBe('LANDED');
    const shoved = playerIn(simulation, 2_000, 'player-1');
    expect(shoved.position.x).toBeGreaterThan(before.x);
    expect(distanceBetween(before, shoved.position)).toBeCloseTo(SHOVE.knockbackPixels);
    expect(isValidPlayerPosition(shoved.position)).toBe(true);
    expect(shoved.recoveringUntilMs).toBe(2_000 + SHOVE.recoveryMs);

    // The target pushes back west during recovery: input is acknowledged but ignored.
    const knockedTo = shoved.position.x;
    for (let tick = 0; tick < 5; tick += 1) {
      simulation.submitInput('player-1', input(tick + 10, { movement: LEFT }));
      simulation.tick(2_010 + tick * 34);
    }
    const recovering = playerIn(simulation, 2_180, 'player-1');
    expect(recovering.position.x).toBe(knockedTo);
    expect(recovering.acknowledgedInputSequence).toBeGreaterThan(0);

    // Once the window closes the same input takes effect again.
    simulation.submitInput('player-1', input(200, { movement: LEFT }));
    simulation.tick(2_000 + SHOVE.recoveryMs + 34);
    expect(playerIn(simulation, 2_500, 'player-1').position.x).toBeLessThan(knockedTo);
  });

  it('resolves a mutual exchange to a single winner by arrival order', () => {
    const simulation = new AuthoritativeRoomSimulation(adjacentRoom());
    simulation.submitInput('player-0', input(1));
    simulation.submitInput('player-1', input(1, { movement: LEFT }));
    simulation.tick(2_000);

    const first = simulation.resolveShove('player-0', shove('player-1'), 2_000);
    const retaliation = simulation.resolveShove('player-1', shove('player-0'), 2_000);
    expect(first.result).toMatchObject({ outcome: 'LANDED' });
    expect(first.landed).not.toBeNull();
    expect(retaliation.result).toMatchObject({ outcome: 'REJECTED', reason: 'RECOVERING' });
    expect(retaliation.landed).toBeNull();
    // Only one player was displaced by the exchange.
    expect(playerIn(simulation, 2_000, 'player-0').recoveringUntilMs).toBeNull();
  });

  it('closes shoving outside the looting phase and for absent players', () => {
    const simulation = new AuthoritativeRoomSimulation(adjacentRoom());
    expect(simulation.resolveShove('player-0', shove('player-1'), 1_500).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
    simulation.tick(2_000);
    expect(simulation.resolveShove('ghost', shove('player-1'), 2_000).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'NOT_IN_MATCH' });
  });

  it('cannot shove a player who is mid-reconnection', () => {
    const base = adjacentRoom();
    const simulation = new AuthoritativeRoomSimulation(base);
    simulation.submitInput('player-0', input(1));
    simulation.tick(2_000);

    base.players[1]!.isConnected = false;
    base.players[1]!.connectionState = 'RECONNECTING';
    simulation.synchronizePlayers(base);
    expect(simulation.resolveShove('player-0', shove('player-1'), 2_000).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'TARGET_UNAVAILABLE' });
  });
});

describe('atomic end-of-looting tally', () => {
  function tallySimulation() {
    const base = room(2);
    base.players[0]!.position = { x: 900, y: 600 };
    base.players[1]!.position = { x: 1_100, y: 600 };
    return { base, simulation: new AuthoritativeRoomSimulation(base, {
      spawns: [
        { id: 'loot-soup', catalogId: 'canned-soup', x: 900, y: 600 },
        { id: 'loot-map', catalogId: 'map', x: 1_100, y: 600 },
      ],
      carts: [
        { id: 'cart-0', slot: 0, label: 'Cart 1', x: 900, y: 600, width: 128, height: 72 },
        { id: 'cart-1', slot: 1, label: 'Cart 2', x: 1_100, y: 600, width: 128, height: 72 },
      ],
      collision: [],
    }) };
  }

  it('uses the scheduled countdown boundary for an exact 69-second window', () => {
    const { simulation } = tallySimulation();
    simulation.tick(2_037);
    expect(simulation.snapshot(2_037)).toMatchObject({
      phase: 'LOOTING',
      phaseEndsAtMs: 2_000 + GAME.lootingDurationMs,
    });
  });

  it('freezes cart contents once and rejects every intent at the exact deadline', () => {
    const { base, simulation } = tallySimulation();
    simulation.tick(2_000);
    const pickup = simulation.resolveInteraction('player-0', {
      requestId: '00000000-0000-4000-8000-000000000201',
      action: 'PICK_UP',
      targetId: 'loot-soup',
    }, 2_001);
    expect(pickup.result.outcome).toBe('PICKED_UP');
    const deposit = simulation.resolveInteraction('player-0', {
      requestId: '00000000-0000-4000-8000-000000000202',
      action: 'DROP_OFF',
      targetId: 'cart-0',
    }, 2_002);
    expect(deposit.result.outcome).toBe('DEPOSITED');

    base.players[1]!.isConnected = false;
    base.players[1]!.connectionState = 'RECONNECTING';
    simulation.synchronizePlayers(base);
    const deadline = 2_000 + GAME.lootingDurationMs;
    const before = playerIn(simulation, deadline - 1, 'player-0').position;
    expect(simulation.submitInput('player-0', input(90), deadline)).toBe(false);
    expect(simulation.resolveInteraction('player-0', {
      requestId: '00000000-0000-4000-8000-000000000203',
      action: 'PICK_UP',
      targetId: 'loot-map',
    }, deadline).result).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
    expect(simulation.resolveShove('player-0', shove('player-1'), deadline).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });

    const ended = simulation.tick(deadline);
    expect(ended).toMatchObject({ phaseChanged: true, tallyCommitted: true });
    expect(playerIn(simulation, deadline, 'player-0').position).toEqual(before);
    expect(simulation.snapshot(deadline)).toMatchObject({
      phase: 'SURVIVAL',
      phaseEndsAtMs: deadline + GAME.survivalDurationMs,
    });
    const result = simulation.tally();
    expect(result).toMatchObject({
      resultId: `ABC234:${deadline}`,
      lootingStartedAtMs: 2_000,
      lootingEndedAtMs: deadline,
      durationMs: GAME.lootingDurationMs,
      totalItems: 1,
      categoryTotals: [{ category: 'food', count: 1 }],
      players: [
        { playerId: 'player-0', totalItems: 1, isConnectedAtEnd: true },
        { playerId: 'player-1', totalItems: 0, isConnectedAtEnd: false },
      ],
    });
    expect(result?.players[0]?.items).toEqual([
      { id: 'loot-soup', catalogId: 'canned-soup', label: 'Canned Soup', category: 'food' },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.players)).toBe(true);

    const duplicateEnd = simulation.tick(deadline + 1_000);
    expect(duplicateEnd.tallyCommitted).toBe(false);
    expect(simulation.tally()).toBe(result);
  });

  it('catches a delayed timer up directly to the same committed tally', () => {
    const { simulation } = tallySimulation();
    const deadline = 2_000 + GAME.lootingDurationMs;
    const delayed = simulation.tick(deadline + 5_000);
    expect(delayed).toMatchObject({ phaseChanged: true, tallyCommitted: true });
    expect(simulation.snapshot(deadline + 5_000).phase).toBe('SURVIVAL');
    expect(simulation.tally()).toMatchObject({
      lootingStartedAtMs: 2_000,
      lootingEndedAtMs: deadline,
      totalItems: 0,
    });
  });
});

describe('AuthoritativeRoomSimulation survival phase', () => {
  const lootingDeadline = 2_000 + GAME.lootingDurationMs;

  /** Runs the countdown and the looting window out, leaving the day just opened. */
  function survivingSimulation(): { base: RoomPublicState; simulation: AuthoritativeRoomSimulation } {
    const base = room(2);
    const simulation = new AuthoritativeRoomSimulation(base);
    simulation.tick(2_000);
    simulation.tick(lootingDeadline);
    return { base, simulation };
  }

  it('enters SURVIVAL at the looting deadline with a 120-second server-owned window', () => {
    const { simulation } = survivingSimulation();
    const snapshot = simulation.snapshot(lootingDeadline);
    expect(snapshot.phase).toBe('SURVIVAL');
    expect(snapshot.phaseEndsAtMs).toBe(lootingDeadline + 120_000);
    expect(snapshot.phaseEndsAtMs).toBe(lootingDeadline + GAME.survivalDurationMs);
    expect(simulation.survivalWindow()).toEqual({
      startedAtMs: lootingDeadline,
      endsAtMs: lootingDeadline + GAME.survivalDurationMs,
    });
  });

  it('measures the day from the authoritative looting deadline, not from a late tick', () => {
    const simulation = new AuthoritativeRoomSimulation(room(2));
    simulation.tick(2_000);
    simulation.tick(lootingDeadline + 5_000);
    // A delayed timer callback shortens the day rather than extending it, exactly
    // as a delayed countdown boundary shortens looting.
    expect(simulation.snapshot(lootingDeadline + 5_000).phaseEndsAtMs)
      .toBe(lootingDeadline + GAME.survivalDurationMs);
  });

  it('does not advance out of SURVIVAL on its own, before or after the deadline', () => {
    const { simulation } = survivingSimulation();
    const survivalDeadline = lootingDeadline + GAME.survivalDurationMs;
    for (const at of [lootingDeadline + 1, survivalDeadline - 1, survivalDeadline, survivalDeadline + 60_000]) {
      const result = simulation.tick(at);
      expect(result).toMatchObject({ phaseChanged: false, tallyCommitted: false, snapshotDue: false });
      expect(simulation.snapshot(at)).toMatchObject({ phase: 'SURVIVAL', phaseEndsAtMs: survivalDeadline });
    }
  });

  it('keeps the frozen looting result the survival day is played from', () => {
    const { base, simulation } = survivingSimulation();
    const result = simulation.tally();
    expect(result).toMatchObject({
      resultId: `ABC234:${lootingDeadline}`,
      lootingEndedAtMs: lootingDeadline,
      durationMs: GAME.lootingDurationMs,
    });
    // Player identities and match membership survive with it, which is what the
    // end-of-day rule will iterate over.
    expect(result?.players.map((player) => player.playerId)).toEqual(base.players.map((player) => player.id));
    expect(Object.isFrozen(result)).toBe(true);
    simulation.tick(lootingDeadline + GAME.survivalDurationMs);
    expect(simulation.tally()).toBe(result);
  });

  it('refuses looting intent during the survival day', () => {
    const { simulation } = survivingSimulation();
    const at = lootingDeadline + 1_000;
    expect(simulation.submitInput('player-0', input(200), at)).toBe(false);
    expect(simulation.resolveInteraction('player-0', {
      requestId: '00000000-0000-4000-8000-000000000401',
      action: 'INTERACT',
    }, at).result).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
    expect(simulation.resolveShove('player-0', shove('player-1'), at).result)
      .toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
  });
});

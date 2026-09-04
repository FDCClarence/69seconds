import {
  GAME,
  NETWORK,
  PLAYER_SPAWN_POSITIONS,
  SHOVE,
  SPRINT,
  SURVIVAL,
  SURVIVAL_CHARACTER_DEFAULTS,
  distanceBetween,
  isValidPlayerPosition,
  simulatePlayerMovement,
  type ClientInput,
  type RoomPublicState,
  type ShoveRequest,
  type SurvivalConsumeRequest,
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

  it('never advances out of SURVIVAL, whether the day is open or rolling into the next', () => {
    const { simulation } = survivingSimulation();
    const survivalDeadline = lootingDeadline + GAME.survivalDurationMs;
    for (const at of [lootingDeadline + 1, survivalDeadline - 1, survivalDeadline, survivalDeadline + 60_000]) {
      const result = simulation.tick(at);
      expect(result).toMatchObject({ phaseChanged: false, tallyCommitted: false, snapshotDue: false });
      expect(simulation.snapshot(at).phase).toBe('SURVIVAL');
    }
    // The day that expired resolved into the next one rather than into another
    // phase: the room is still in SURVIVAL, now on a later day and deadline.
    expect(simulation.survivalDayNumber()).toBeGreaterThan(SURVIVAL.firstDayNumber);
  });

  it('keeps the first day\'s deadline while every household is still in it', () => {
    const { simulation } = survivingSimulation();
    const survivalDeadline = lootingDeadline + GAME.survivalDurationMs;
    for (const at of [lootingDeadline + 1, lootingDeadline + 60_000, survivalDeadline - 1]) {
      simulation.tick(at);
      expect(simulation.snapshot(at)).toMatchObject({ phase: 'SURVIVAL', phaseEndsAtMs: survivalDeadline });
      expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber);
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

  it('owns per-player End Day readiness and exposes the future action lock', () => {
    const { simulation } = survivingSimulation();
    const at = lootingDeadline + 1_000;
    expect(simulation.canPerformSurvivalDayActions('player-0', at)).toBe(true);
    const ended = simulation.endSurvivalDay('player-0', at);
    expect(ended).toMatchObject({
      accepted: true,
      changed: true,
      state: { activePlayerCount: 1, allPlayersEnded: false },
    });
    expect(simulation.canPerformSurvivalDayActions('player-0', at + 1)).toBe(false);
    expect(simulation.canPerformSurvivalDayActions('player-1', at + 1)).toBe(true);
  });

  it('rejects non-household identities and End Day outside SURVIVAL', () => {
    const beforeDay = new AuthoritativeRoomSimulation(room(2));
    expect(beforeDay.endSurvivalDay('player-0', 1_500))
      .toEqual({ accepted: false, reason: 'INVALID_PHASE' });
    const { simulation } = survivingSimulation();
    expect(simulation.endSurvivalDay('another-player', lootingDeadline + 1))
      .toEqual({ accepted: false, reason: 'NOT_ACTIVE_HOUSEHOLD' });
    expect(simulation.survivalReadiness()?.activePlayerCount).toBe(2);
  });

  it('auto-ends the remaining household at timeout and resolves the day it ended', () => {
    const { simulation } = survivingSimulation();
    simulation.endSurvivalDay('player-0', lootingDeadline + 500);
    const timeout = lootingDeadline + GAME.survivalDurationMs;
    // One household never pressed End Day, so only the deadline can close this
    // day — and it does, in the tick that reaches it.
    const tick = simulation.tick(timeout);
    expect(tick).toMatchObject({ readinessChanged: true, survivalDayAdvanced: true, phaseChanged: false });
    expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber + 1);
    // Nobody carries an ended day into the new one, and nothing is left ended.
    expect(simulation.allPlayersEnded()).toBe(false);
    expect(simulation.survivalReadiness()).toMatchObject({
      dayNumber: SURVIVAL.firstDayNumber + 1,
      startedAtMs: timeout,
      endsAtMs: timeout + GAME.survivalDurationMs,
      activePlayerCount: 2,
      allPlayersEnded: false,
    });
    expect(simulation.tick(timeout + 1)).toMatchObject({
      readinessChanged: false,
      survivalDayAdvanced: false,
    });
  });

  it('sets all-players-ended as soon as the last household ends before timeout', () => {
    const { simulation } = survivingSimulation();
    simulation.endSurvivalDay('player-0', lootingDeadline + 1_000);
    const last = simulation.endSurvivalDay('player-1', lootingDeadline + 2_000);
    expect(last).toMatchObject({ accepted: true, changed: true, state: { allPlayersEnded: true } });
    expect(simulation.allPlayersEnded()).toBe(true);
    expect(lootingDeadline + 2_000).toBeLessThan(lootingDeadline + GAME.survivalDurationMs);
    // The request itself resolves nothing: the day is still Day 1 until the
    // server's own tick closes it.
    expect(simulation.snapshot(lootingDeadline + 2_000).phase).toBe('SURVIVAL');
    expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber);
    expect(simulation.survivalState()?.dayNumber).toBe(SURVIVAL.firstDayNumber);
  });
});

describe('survival household initialization', () => {
  const deadline = 2_000 + GAME.lootingDurationMs;

  /**
   * Two players, one item and one person within reach of each. Everything is
   * injected so a household can be built without walking anybody across the
   * store, the same seam the loot authority tests use.
   */
  function housedSimulation() {
    const base = room(2);
    base.players[0]!.position = { x: 900, y: 600 };
    base.players[1]!.position = { x: 1_100, y: 600 };
    return { base, simulation: new AuthoritativeRoomSimulation(base, {
      spawns: [
        { id: 'loot-soup', catalogId: 'canned-soup', x: 900, y: 600 },
        { id: 'loot-map', catalogId: 'map', x: 1_100, y: 600 },
      ],
      npcSpawns: [
        { id: 'npc-maya', catalogId: 'maya', x: 900, y: 600 },
        { id: 'npc-gort', catalogId: 'gort', x: 1_100, y: 600 },
      ],
      carts: [
        { id: 'cart-0', slot: 0, label: 'Cart 1', x: 900, y: 600, width: 128, height: 72 },
        { id: 'cart-1', slot: 1, label: 'Cart 2', x: 1_100, y: 600, width: 128, height: 72 },
      ],
      collision: [],
    }) };
  }

  let requestCounter = 500;
  function bank(
    simulation: AuthoritativeRoomSimulation,
    playerId: string,
    targetId: string,
    cartId: string,
    atMs: number,
  ): void {
    const pickUp = simulation.resolveInteraction(playerId, {
      requestId: `00000000-0000-4000-8000-${String(requestCounter += 1).padStart(12, '0')}`,
      action: 'PICK_UP',
      targetId,
    }, atMs);
    expect(pickUp.result.outcome).toBe('PICKED_UP');
    const deposit = simulation.resolveInteraction(playerId, {
      requestId: `00000000-0000-4000-8000-${String(requestCounter += 1).padStart(12, '0')}`,
      action: 'DROP_OFF',
      targetId: cartId,
    }, atMs);
    expect(deposit.result.outcome).toBe('DEPOSITED');
  }

  /** Player 0 recruits Maya and banks soup; player 1 recruits Gort only. */
  function playedDay() {
    const { base, simulation } = housedSimulation();
    simulation.tick(2_000);
    bank(simulation, 'player-0', 'loot-soup', 'cart-0', 2_001);
    bank(simulation, 'player-0', 'npc-maya', 'cart-0', 2_002);
    bank(simulation, 'player-1', 'npc-gort', 'cart-1', 2_003);
    simulation.tick(deadline);
    return { base, simulation };
  }

  it('produces no survival state until the server reaches the buzzer', () => {
    const { simulation } = housedSimulation();
    expect(simulation.survivalState()).toBeNull();
    simulation.tick(2_000);
    bank(simulation, 'player-0', 'npc-maya', 'cart-0', 2_001);
    // Recruited, banked, and still no household: the day has not opened.
    expect(simulation.survivalState()).toBeNull();
    simulation.tick(deadline - 1);
    expect(simulation.survivalState()).toBeNull();
    simulation.tick(deadline);
    expect(simulation.survivalState()).not.toBeNull();
  });

  it('builds one household per player from its own authoritative carts', () => {
    const { simulation } = playedDay();
    const state = simulation.survivalState();
    expect(state).toMatchObject({
      stateId: `survival:ABC234:${deadline}`,
      roomCode: 'ABC234',
      startedAtMs: deadline,
    });
    expect(state?.households.map((household) => household.playerId)).toEqual(['player-0', 'player-1']);
    // Each household holds its own main character plus only its own recruit, and
    // the soup stays inventory rather than becoming somebody.
    expect(state?.households[0]?.characters.map((character) => [character.kind, character.displayName]))
      .toEqual([['MAIN', 'Player 0'], ['NPC', 'Maya']]);
    expect(state?.households[1]?.characters.map((character) => [character.kind, character.displayName]))
      .toEqual([['MAIN', 'Player 1'], ['NPC', 'Gort']]);
    expect(state?.households[0]?.inventory).toEqual([
      { id: 'loot-soup', catalogId: 'canned-soup', label: 'Canned Soup', category: 'food' },
    ]);
    expect(state?.households[1]?.inventory).toEqual([]);
    expect(state?.households.flatMap((household) => household.characters)
      .every((character) => character.isAlive)).toBe(true);
  });

  it('gives every character the shared defaults, as separate values', () => {
    const { simulation } = playedDay();
    for (const household of simulation.survivalState()?.households ?? []) {
      for (const character of household.characters) {
        expect(character.stats).toEqual(SURVIVAL_CHARACTER_DEFAULTS.stats);
        expect(character.dailyNutritionCost).toBe(SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost);
        expect(character.dailyHydrationCost).toBe(SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost);
        expect(character.stats.survival.current).not.toBe(character.stats.survival.max);
      }
    }
  });

  it('commits the households once and keeps returning the same frozen object all day', () => {
    const { simulation } = playedDay();
    const state = simulation.survivalState();
    expect(Object.isFrozen(state)).toBe(true);
    for (const at of [deadline + 1, deadline + 60_000, deadline + GAME.survivalDurationMs - 1]) {
      expect(simulation.tick(at).tallyCommitted).toBe(false);
      // Only end-of-day resolution ever replaces this object, so every tick
      // inside the open day hands back the very same households.
      expect(simulation.survivalState()).toBe(state);
    }
  });

  it('counts a recruit as one household member despite costing every carry slot', () => {
    const { simulation } = playedDay();
    const household = simulation.survivalState()?.households[0];
    // Maya filled all four looting carry slots and is one character.
    expect(household?.characters.filter((character) => character.kind === 'NPC')).toHaveLength(1);
    expect(household?.characters).toHaveLength(2);
  });
});

describe('survival day number', () => {
  const lootingDeadline = 2_000 + GAME.lootingDurationMs;

  /** Runs the countdown and looting out, leaving the first survival day open. */
  function openedDay(): AuthoritativeRoomSimulation {
    const simulation = new AuthoritativeRoomSimulation(room(2));
    simulation.tick(2_000);
    simulation.tick(lootingDeadline);
    return simulation;
  }

  it('opens the first survival day as Day 1, since the grocery run precedes it', () => {
    const simulation = openedDay();
    expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber);
    expect(simulation.survivalDayNumber()).toBe(1);
    // Every client reads the day off this one committed object.
    expect(simulation.survivalState()?.dayNumber).toBe(1);
  });

  it('reports the first day before the buzzer too, so the number is never absent', () => {
    const simulation = new AuthoritativeRoomSimulation(room(1));
    expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber);
    simulation.tick(2_000);
    expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber);
  });

  it('does not advance the day while it is still being played, nor on a client\'s word', () => {
    const simulation = openedDay();
    const state = simulation.survivalState();
    // Well past the two-second client transition, and with one household having
    // ended: a day advances only once *every* household is done with it.
    simulation.endSurvivalDay('player-0', lootingDeadline + 1_500);
    for (const at of [lootingDeadline + 2_000, lootingDeadline + 60_000, lootingDeadline + GAME.survivalDurationMs - 1]) {
      simulation.tick(at);
      expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber);
      expect(simulation.survivalState()).toBe(state);
      expect(simulation.survivalState()?.dayNumber).toBe(1);
    }
  });

  it('keeps the day and the day\'s deadline independent of the client transition', () => {
    const simulation = openedDay();
    const endsAtMs = lootingDeadline + GAME.survivalDurationMs;
    // The client fades `Day #1` in and out over its first two seconds. Nothing
    // it does reaches the server, so the deadline is still measured from the
    // looting buzzer and is two seconds shorter for having shown it.
    simulation.tick(lootingDeadline + 2_000);
    expect(simulation.snapshot(lootingDeadline + 2_000)).toMatchObject({
      phase: 'SURVIVAL',
      phaseEndsAtMs: endsAtMs,
    });
    expect(simulation.survivalWindow()).toEqual({ startedAtMs: lootingDeadline, endsAtMs });
  });
});

describe('survival day resolution', () => {
  const lootingDeadline = 2_000 + GAME.lootingDurationMs;
  const firstDeadline = lootingDeadline + GAME.survivalDurationMs;
  const { dailyNutritionCost, dailyHydrationCost } = SURVIVAL_CHARACTER_DEFAULTS;

  /** Two players, the first survival day open and nobody finished with it. */
  function openedDay(): AuthoritativeRoomSimulation {
    const simulation = new AuthoritativeRoomSimulation(room(2));
    simulation.tick(2_000);
    simulation.tick(lootingDeadline);
    return simulation;
  }

  /** Every household's `[nutrition, hydration]`, in household order. */
  function resources(simulation: AuthoritativeRoomSimulation): readonly [number, number][] {
    return (simulation.survivalState()?.households ?? []).flatMap((household) =>
      household.characters.map((character): [number, number] => [
        character.stats.nutrition.current,
        character.stats.hydration.current,
      ]));
  }

  it('resolves the day and opens the next one once every household has ended', () => {
    const simulation = openedDay();
    const endedAt = lootingDeadline + 30_000;
    simulation.endSurvivalDay('player-0', endedAt);
    simulation.endSurvivalDay('player-1', endedAt);

    const tick = simulation.tick(endedAt);
    expect(tick).toMatchObject({
      survivalDayAdvanced: true,
      readinessChanged: true,
      phaseChanged: false,
      tallyCommitted: false,
    });
    expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber + 1);
    expect(simulation.survivalState()).toMatchObject({
      dayNumber: SURVIVAL.firstDayNumber + 1,
      startedAtMs: endedAt,
    });
    // Ending early opens the next day early: the new window is a full 120
    // seconds measured from the moment the last household finished.
    expect(simulation.survivalWindow()).toEqual({
      startedAtMs: endedAt,
      endsAtMs: endedAt + GAME.survivalDurationMs,
    });
    expect(simulation.snapshot(endedAt)).toMatchObject({
      phase: 'SURVIVAL',
      phaseEndsAtMs: endedAt + GAME.survivalDurationMs,
    });
  });

  it('spends one day of Nutrition and Hydration, once, for every character', () => {
    const simulation = openedDay();
    const full = 100 - 0;
    expect(resources(simulation)).toEqual([[full, full], [full, full]]);

    simulation.endSurvivalDay('player-0', lootingDeadline + 1);
    simulation.endSurvivalDay('player-1', lootingDeadline + 1);
    simulation.tick(lootingDeadline + 1);

    const drained: [number, number] = [full - dailyNutritionCost, full - dailyHydrationCost];
    expect(resources(simulation)).toEqual([drained, drained]);
    expect(dailyNutritionCost).toBeGreaterThan(0);
    expect(dailyHydrationCost).toBeGreaterThan(0);
  });

  it('resolves a day exactly once, however many ticks observe it ended', () => {
    const simulation = openedDay();
    simulation.endSurvivalDay('player-0', lootingDeadline + 5_000);
    simulation.endSurvivalDay('player-1', lootingDeadline + 5_000);
    expect(simulation.tick(lootingDeadline + 5_000).survivalDayAdvanced).toBe(true);
    const afterOneDay = resources(simulation);
    const dayTwo = simulation.survivalState();

    // The next day is open and unfinished, so nothing resolves again — not on
    // the same millisecond, and not on any tick that follows.
    for (const at of [lootingDeadline + 5_000, lootingDeadline + 5_001, lootingDeadline + 20_000]) {
      expect(simulation.tick(at).survivalDayAdvanced).toBe(false);
      expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber + 1);
      expect(simulation.survivalState()).toBe(dayTwo);
      expect(resources(simulation)).toEqual(afterOneDay);
    }
  });

  it('resolves a timed-out day on its authoritative deadline, not on a late tick', () => {
    const simulation = openedDay();
    // A delayed timer callback: the day it closes still ended at 120 seconds,
    // so the next day starts there rather than being handed the lost time.
    expect(simulation.tick(firstDeadline + 5_000).survivalDayAdvanced).toBe(true);
    expect(simulation.survivalState()?.startedAtMs).toBe(firstDeadline);
    expect(simulation.survivalWindow()).toEqual({
      startedAtMs: firstDeadline,
      endsAtMs: firstDeadline + GAME.survivalDurationMs,
    });
    expect(simulation.survivalReadiness()).toMatchObject({
      dayNumber: SURVIVAL.firstDayNumber + 1,
      startedAtMs: firstDeadline,
      endsAtMs: firstDeadline + GAME.survivalDurationMs,
    });
  });

  it('resets End Day readiness so every household can play the new day', () => {
    const simulation = openedDay();
    const endedAt = lootingDeadline + 10_000;
    simulation.endSurvivalDay('player-0', endedAt);
    simulation.endSurvivalDay('player-1', endedAt);
    expect(simulation.canPerformSurvivalDayActions('player-0', endedAt)).toBe(false);

    simulation.tick(endedAt);
    expect(simulation.survivalReadiness()?.players).toEqual([
      { playerId: 'player-0', hasEnded: false, endedAtMs: null, endedBy: null },
      { playerId: 'player-1', hasEnded: false, endedAtMs: null, endedBy: null },
    ]);
    expect(simulation.allPlayersEnded()).toBe(false);
    // The households that just ended a day may act in the new one, and ending
    // it again is what resolves the day after.
    expect(simulation.canPerformSurvivalDayActions('player-0', endedAt + 1)).toBe(true);
    expect(simulation.canPerformSurvivalDayActions('player-1', endedAt + 1)).toBe(true);
    expect(simulation.endSurvivalDay('player-0', endedAt + 1))
      .toMatchObject({ accepted: true, changed: true, state: { dayNumber: 2 } });
  });

  it('drains one day per resolved day across consecutive timed-out days', () => {
    const simulation = openedDay();
    simulation.tick(firstDeadline);
    const secondDeadline = firstDeadline + GAME.survivalDurationMs;
    simulation.tick(secondDeadline);

    expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber + 2);
    const twiceDrained: [number, number] = [
      100 - dailyNutritionCost * 2,
      100 - dailyHydrationCost * 2,
    ];
    expect(resources(simulation)).toEqual([twiceDrained, twiceDrained]);
    expect(simulation.survivalState()?.startedAtMs).toBe(secondDeadline);
  });

  it('keeps every household, recruit, inventory line, and untouched stat', () => {
    const base = room(2);
    base.players[0]!.position = { x: 900, y: 600 };
    const simulation = new AuthoritativeRoomSimulation(base, {
      spawns: [{ id: 'loot-soup', catalogId: 'canned-soup', x: 900, y: 600 }],
      npcSpawns: [{ id: 'npc-maya', catalogId: 'maya', x: 900, y: 600 }],
      carts: [
        { id: 'cart-0', slot: 0, label: 'Cart 1', x: 900, y: 600, width: 128, height: 72 },
        { id: 'cart-1', slot: 1, label: 'Cart 2', x: 1_100, y: 600, width: 128, height: 72 },
      ],
      collision: [],
    });
    simulation.tick(2_000);
    let requestId = 900;
    const interact = (action: 'PICK_UP' | 'DROP_OFF', targetId: string, atMs: number) =>
      simulation.resolveInteraction('player-0', {
        requestId: `00000000-0000-4000-8000-${String(requestId += 1).padStart(12, '0')}`,
        action,
        targetId,
      }, atMs).result.outcome;
    // The soup becomes inventory and Maya becomes a household member, so the
    // resolved day has both kinds of thing to carry forward.
    expect(interact('PICK_UP', 'loot-soup', 2_001)).toBe('PICKED_UP');
    expect(interact('DROP_OFF', 'cart-0', 2_001)).toBe('DEPOSITED');
    expect(interact('PICK_UP', 'npc-maya', 2_002)).toBe('PICKED_UP');
    expect(interact('DROP_OFF', 'cart-0', 2_002)).toBe('DEPOSITED');
    simulation.tick(lootingDeadline);
    const dayOne = simulation.survivalState();
    expect(dayOne?.households[0]?.characters).toHaveLength(2);

    simulation.tick(firstDeadline);
    const dayTwo = simulation.survivalState();
    expect(dayTwo?.stateId).toBe(dayOne?.stateId);
    expect(dayTwo?.households.map((household) => household.playerId))
      .toEqual(dayOne?.households.map((household) => household.playerId));
    // Maya is still a household member, the soup is still deposited inventory,
    // and only the two resources a day costs have moved.
    expect(dayTwo?.households[0]?.characters.map((character) => character.displayName))
      .toEqual(['Player 0', 'Maya']);
    expect(dayTwo?.households[0]?.inventory).toEqual(dayOne?.households[0]?.inventory);
    for (const character of dayTwo?.households.flatMap((household) => household.characters) ?? []) {
      expect(character.stats).toMatchObject({
        health: SURVIVAL_CHARACTER_DEFAULTS.stats.health,
        survival: SURVIVAL_CHARACTER_DEFAULTS.stats.survival,
        morale: SURVIVAL_CHARACTER_DEFAULTS.stats.morale,
        strength: SURVIVAL_CHARACTER_DEFAULTS.stats.strength,
      });
      // Nobody dies of a resolved day in this model, only of the coming rolls.
      expect(character.isAlive).toBe(true);
    }
  });

  it('resolves nothing while the room has never reached a survival day', () => {
    const simulation = new AuthoritativeRoomSimulation(room(2));
    for (const at of [1_500, 2_000, lootingDeadline - 1]) {
      expect(simulation.tick(at).survivalDayAdvanced).toBe(false);
    }
    // The buzzer opens Day 1; it does not also resolve it.
    expect(simulation.tick(lootingDeadline)).toMatchObject({
      survivalDayAdvanced: false,
      tallyCommitted: true,
    });
    expect(simulation.survivalDayNumber()).toBe(SURVIVAL.firstDayNumber);
  });
});

describe('survival feeding', () => {
  const lootingDeadline = 2_000 + GAME.lootingDurationMs;
  const NUTRITION_COST = SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost;
  const HYDRATION_COST = SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost;

  let feedCounter = 900;
  function feedRequest(itemId: string, characterId: string): SurvivalConsumeRequest {
    feedCounter += 1;
    return {
      requestId: `00000000-0000-4000-8000-${String(feedCounter).padStart(12, '0')}`,
      itemId,
      characterId,
    };
  }

  let bankCounter = 700;
  function bank(
    simulation: AuthoritativeRoomSimulation,
    playerId: string,
    targetIds: readonly string[],
    cartId: string,
    atMs: number,
  ): void {
    for (const targetId of targetIds) {
      const pickUp = simulation.resolveInteraction(playerId, {
        requestId: `00000000-0000-4000-8000-${String(bankCounter += 1).padStart(12, '0')}`,
        action: 'PICK_UP',
        targetId,
      }, atMs);
      expect(pickUp.result.outcome).toBe('PICKED_UP');
    }
    const deposit = simulation.resolveInteraction(playerId, {
      requestId: `00000000-0000-4000-8000-${String(bankCounter += 1).padStart(12, '0')}`,
      action: 'DROP_OFF',
      targetId: cartId,
    }, atMs);
    expect(deposit.result.outcome).toBe('DEPOSITED');
  }

  /**
   * Two households that reach Day 1 with real deposited inventory: player 0
   * banks a soup, a water, a meal, and a pistol, and player 1 banks a soup of
   * their own. Everything is placed within reach of a standing player, the same
   * seam the household initialization tests use.
   */
  function fedSimulation(): AuthoritativeRoomSimulation {
    const base = room(2);
    base.players[0]!.position = { x: 900, y: 600 };
    base.players[1]!.position = { x: 1_100, y: 600 };
    const simulation = new AuthoritativeRoomSimulation(base, {
      spawns: [
        { id: 'loot-soup', catalogId: 'canned-soup', x: 900, y: 600 },
        { id: 'loot-water', catalogId: 'bottled-water', x: 900, y: 600 },
        { id: 'loot-mre', catalogId: 'microwave-meal', x: 900, y: 600 },
        { id: 'loot-pistol', catalogId: 'pistol', x: 900, y: 600 },
        { id: 'loot-their-soup', catalogId: 'canned-soup', x: 1_100, y: 600 },
      ],
      npcSpawns: [],
      carts: [
        { id: 'cart-0', slot: 0, label: 'Cart 1', x: 900, y: 600, width: 128, height: 72 },
        { id: 'cart-1', slot: 1, label: 'Cart 2', x: 1_100, y: 600, width: 128, height: 72 },
      ],
      collision: [],
    });
    simulation.tick(2_000);
    bank(simulation, 'player-0', ['loot-soup', 'loot-water', 'loot-mre', 'loot-pistol'], 'cart-0', 2_001);
    bank(simulation, 'player-1', ['loot-their-soup'], 'cart-1', 2_002);
    simulation.tick(lootingDeadline);
    return simulation;
  }

  /** Closes the open day for both households and opens the next one. */
  function passDay(simulation: AuthoritativeRoomSimulation, atMs: number): void {
    for (const playerId of ['player-0', 'player-1']) {
      expect(simulation.endSurvivalDay(playerId, atMs).accepted).toBe(true);
    }
    expect(simulation.tick(atMs).survivalDayAdvanced).toBe(true);
  }

  function characterIn(simulation: AuthoritativeRoomSimulation, playerId: string) {
    return simulation.survivalState()!.households
      .find((household) => household.playerId === playerId)!.characters[0]!;
  }

  function inventoryIds(simulation: AuthoritativeRoomSimulation, playerId: string): string[] {
    return simulation.survivalState()!.households
      .find((household) => household.playerId === playerId)!.inventory.map((item) => item.id);
  }

  it('restores 50 Nutrition to a household\'s own character and spends the item', () => {
    const simulation = fedSimulation();
    // Three resolved days of the shared daily cost, so there is real room to
    // restore rather than a full character the soup would simply top up.
    let dayStartMs = lootingDeadline;
    for (let day = 0; day < 3; day += 1) {
      dayStartMs += 1_000;
      passDay(simulation, dayStartMs);
    }
    const before = characterIn(simulation, 'player-0');
    expect(before.stats.nutrition).toEqual({ current: 100 - 3 * NUTRITION_COST, max: 100 });

    const resolution = simulation.resolveSurvivalConsumption(
      'player-0',
      feedRequest('loot-soup', 'player-0'),
      dayStartMs + 500,
    );
    expect(resolution.result.outcome).toBe('CONSUMED');
    const after = characterIn(simulation, 'player-0');
    expect(after.stats.nutrition).toEqual({ current: before.stats.nutrition.current + 50, max: 100 });
    // Soup is food, not drink: the day's hydration loss is still there.
    expect(after.stats.hydration).toEqual({ current: 100 - 3 * HYDRATION_COST, max: 100 });
    // The committed day is replaced, and the eaten tin is gone from it.
    expect(inventoryIds(simulation, 'player-0')).toEqual(['loot-water', 'loot-mre', 'loot-pistol']);
    expect(simulation.survivalState()).toBe(resolution.state);
  });

  it('restores 50 Hydration from water and fills both stats from a microwave meal', () => {
    const simulation = fedSimulation();
    let dayStartMs = lootingDeadline;
    for (let day = 0; day < 3; day += 1) {
      dayStartMs += 1_000;
      passDay(simulation, dayStartMs);
    }
    const drained = characterIn(simulation, 'player-0').stats;

    expect(simulation.resolveSurvivalConsumption(
      'player-0', feedRequest('loot-water', 'player-0'), dayStartMs + 100,
    ).result.outcome).toBe('CONSUMED');
    expect(characterIn(simulation, 'player-0').stats.hydration)
      .toEqual({ current: drained.hydration.current + 50, max: 100 });
    expect(characterIn(simulation, 'player-0').stats.nutrition).toEqual(drained.nutrition);

    // The meal ignores how empty either stat is and tops both up to this
    // character's own maximums.
    expect(simulation.resolveSurvivalConsumption(
      'player-0', feedRequest('loot-mre', 'player-0'), dayStartMs + 200,
    ).result.outcome).toBe('CONSUMED');
    expect(characterIn(simulation, 'player-0').stats.nutrition).toEqual({ current: 100, max: 100 });
    expect(characterIn(simulation, 'player-0').stats.hydration).toEqual({ current: 100, max: 100 });
    expect(inventoryIds(simulation, 'player-0')).toEqual(['loot-soup', 'loot-pistol']);
  });

  it('refuses a pistol, an item nobody deposited, and a person who is not in the household', () => {
    const simulation = fedSimulation();
    const at = lootingDeadline + 1_000;
    for (const [request, reason] of [
      [feedRequest('loot-pistol', 'player-0'), 'NOT_CONSUMABLE'],
      [feedRequest('loot-nothing', 'player-0'), 'UNKNOWN_ITEM'],
      [feedRequest('loot-soup', 'nobody'), 'UNKNOWN_CHARACTER'],
    ] as const) {
      const resolution = simulation.resolveSurvivalConsumption('player-0', request, at);
      expect(resolution.result).toMatchObject({ outcome: 'REJECTED', reason });
      expect(resolution.state).toBeNull();
    }
    // Every rejection left the household exactly as the buzzer built it.
    expect(inventoryIds(simulation, 'player-0'))
      .toEqual(['loot-soup', 'loot-water', 'loot-mre', 'loot-pistol']);
    expect(characterIn(simulation, 'player-0').stats)
      .toEqual(SURVIVAL_CHARACTER_DEFAULTS.stats);
  });

  it('refuses another household\'s character and another household\'s item', () => {
    const simulation = fedSimulation();
    const at = lootingDeadline + 1_000;
    const committed = simulation.survivalState();

    // Their character is not in my household, and their soup is not in my
    // inventory. Neither is reachable, and neither costs me anything.
    expect(simulation.resolveSurvivalConsumption(
      'player-0', feedRequest('loot-soup', 'player-1'), at,
    ).result).toMatchObject({ outcome: 'REJECTED', reason: 'UNKNOWN_CHARACTER' });
    expect(simulation.resolveSurvivalConsumption(
      'player-0', feedRequest('loot-their-soup', 'player-0'), at,
    ).result).toMatchObject({ outcome: 'REJECTED', reason: 'UNKNOWN_ITEM' });
    // A socket that is in no household at all owns nothing to feed with.
    expect(simulation.resolveSurvivalConsumption(
      'player-9', feedRequest('loot-soup', 'player-0'), at,
    ).result).toMatchObject({ outcome: 'REJECTED', reason: 'NO_HOUSEHOLD' });

    expect(simulation.survivalState()).toBe(committed);
    expect(inventoryIds(simulation, 'player-1')).toEqual(['loot-their-soup']);
  });

  it('closes feeding once that household has ended its day, for it alone', () => {
    const simulation = fedSimulation();
    const at = lootingDeadline + 1_000;
    expect(simulation.endSurvivalDay('player-0', at).accepted).toBe(true);

    const refused = simulation.resolveSurvivalConsumption(
      'player-0', feedRequest('loot-soup', 'player-0'), at + 1,
    );
    expect(refused.result).toMatchObject({ outcome: 'REJECTED', reason: 'DAY_ALREADY_ENDED' });
    expect(refused.state).toBeNull();
    expect(inventoryIds(simulation, 'player-0'))
      .toEqual(['loot-soup', 'loot-water', 'loot-mre', 'loot-pistol']);
    // The household that has not ended its day is unaffected by the one that has.
    expect(simulation.resolveSurvivalConsumption(
      'player-1', feedRequest('loot-their-soup', 'player-1'), at + 2,
    ).result.outcome).toBe('CONSUMED');
    expect(inventoryIds(simulation, 'player-1')).toEqual([]);
  });

  it('closes feeding outside an open survival day', () => {
    const base = room(2);
    const simulation = new AuthoritativeRoomSimulation(base);
    // Before the buzzer there is no day and nothing to feed from.
    expect(simulation.resolveSurvivalConsumption(
      'player-0', feedRequest('loot-soup', 'player-0'), 2_500,
    ).result).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });

    const opened = fedSimulation();
    // Past the deadline the day is over even though the tick that resolves it
    // has not run yet, so nobody sneaks a meal into a closed day.
    expect(opened.resolveSurvivalConsumption(
      'player-0',
      feedRequest('loot-soup', 'player-0'),
      lootingDeadline + GAME.survivalDurationMs,
    ).result).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
    expect(inventoryIds(opened, 'player-0'))
      .toEqual(['loot-soup', 'loot-water', 'loot-mre', 'loot-pistol']);
  });

  it('replays a duplicate request across the day rollover without eating twice', () => {
    const simulation = fedSimulation();
    const request = feedRequest('loot-soup', 'player-0');
    const first = simulation.resolveSurvivalConsumption('player-0', request, lootingDeadline + 500);
    expect(first.result.outcome).toBe('CONSUMED');
    expect(inventoryIds(simulation, 'player-0')).toEqual(['loot-water', 'loot-mre', 'loot-pistol']);

    passDay(simulation, lootingDeadline + 1_000);
    const dayTwo = simulation.survivalState();
    // A retry delivered a whole day later is still the feed it was: it reports
    // the original decision, opens no second tin, and replaces no state.
    const repeated = simulation.resolveSurvivalConsumption(
      'player-0', request, lootingDeadline + 1_500,
    );
    expect(repeated).toEqual({ result: first.result, state: null, replayed: true });
    expect(simulation.survivalState()).toBe(dayTwo);
    expect(inventoryIds(simulation, 'player-0')).toEqual(['loot-water', 'loot-mre', 'loot-pistol']);
  });
});

import {
  GAME,
  NETWORK,
  PLAYER_SPAWN_POSITIONS,
  isValidPlayerPosition,
  simulatePlayerMovement,
  type ClientInput,
  type RoomPublicState,
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
      carriedItemIds: [],
      depositedItemIds: [],
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

  it('schedules twenty compact snapshots per thirty fixed simulation ticks', () => {
    const simulation = new AuthoritativeRoomSimulation(room());
    let snapshots = 0;
    for (let tick = 0; tick < NETWORK.simulationTickRateHz; tick += 1) {
      if (simulation.tick(1_000 + tick).snapshotDue) snapshots += 1;
    }
    expect(snapshots).toBe(NETWORK.snapshotRateHz);
  });
});

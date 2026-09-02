import {
  NETWORK,
  simulatePlayerMovement,
  type ClientInput,
  type GamePhase,
  type Vector2,
} from '@69-seconds/shared';

export function reconcilePredictedPosition(
  authoritativePosition: Vector2,
  pendingInputs: readonly ClientInput[],
  acknowledgedInputSequence: number,
  phase: GamePhase,
): { position: Vector2; pendingInputs: ClientInput[] } {
  const unacknowledged = pendingInputs.filter((input) => input.sequence > acknowledgedInputSequence);
  let position = { ...authoritativePosition };
  if (phase === 'LOOTING') {
    for (const input of unacknowledged) {
      position = simulatePlayerMovement(
        position,
        input.movement,
        input.sprint,
        1 / NETWORK.simulationTickRateHz,
      );
    }
  }
  return { position, pendingInputs: unacknowledged };
}

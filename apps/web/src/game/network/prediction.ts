import {
  NETWORK,
  resolveSprint,
  simulatePlayerMovement,
  type ClientInput,
  type GamePhase,
  type SprintState,
  type Vector2,
} from '@69-seconds/shared';

const FIXED_DELTA_SECONDS = 1 / NETWORK.simulationTickRateHz;

/** The authoritative slice of one snapshot that local prediction rebuilds from. */
export interface AuthoritativePlayerState {
  position: Vector2;
  stamina: number;
  exhausted: boolean;
}

export interface PredictedPlayerState {
  position: Vector2;
  sprint: SprintState;
  pendingInputs: ClientInput[];
}

/**
 * Replays every unacknowledged input on top of the server's last word, stepping
 * the sprint resource through the same shared resolver the server tick uses, so
 * a predicted bar and a predicted position never disagree with what arrives next.
 *
 * A recovering player is the one case prediction sits out entirely: the server is
 * ignoring that player's input, so replaying it would only fight the snapshot.
 */
export function reconcilePredictedState(
  authoritative: AuthoritativePlayerState,
  pendingInputs: readonly ClientInput[],
  acknowledgedInputSequence: number,
  phase: GamePhase,
  recovering: boolean,
): PredictedPlayerState {
  const unacknowledged = pendingInputs.filter((input) => input.sequence > acknowledgedInputSequence);
  let position = { ...authoritative.position };
  let sprint: SprintState = { stamina: authoritative.stamina, exhausted: authoritative.exhausted };
  if (phase === 'LOOTING' && !recovering) {
    for (const input of unacknowledged) {
      const resolved = resolveSprint(sprint, input.movement, input.sprint, FIXED_DELTA_SECONDS);
      sprint = resolved.state;
      position = simulatePlayerMovement(position, input.movement, resolved.sprinting, FIXED_DELTA_SECONDS);
    }
  }
  return { position, sprint, pendingInputs: unacknowledged };
}

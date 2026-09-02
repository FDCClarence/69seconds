import {
  GROCERY_STORE_COLLISION,
  SHOVE,
  SHOVE_OBSTACLES,
  distanceBetween,
  hasLineOfAccess,
  isWithinFacingCone,
  isWithinInteractionRadius,
  normalizeMovementVector,
  shoveLandedSchema,
  shoveResultSchema,
  sweepKnockback,
  type CollisionRectangle,
  type GamePhase,
  type ShoveLanded,
  type ShoveRejectionReason,
  type ShoveRequest,
  type ShoveResult,
  type Vector2,
} from '@69-seconds/shared';

/** The simulation's view of one player, passed in rather than owned here. */
export interface ShoveParticipant {
  id: string;
  position: Vector2;
  /** Server-owned facing, from the last non-zero movement input it accepted. */
  facing: Vector2;
  /** Server clock time until which this player's own input is ignored. */
  recoveringUntilMs: number;
  /** False while disconnected or reconnecting, which makes a player unshovable. */
  eligible: boolean;
}

export interface ShoveContext {
  shoverId: string;
  participants: readonly ShoveParticipant[];
  phase: GamePhase;
  phaseEndsAtMs: number | null;
  serverNowMs: number;
  request: ShoveRequest;
}

/** What the simulation must apply to its own player state after a committed shove. */
export interface ShoveEffect {
  targetPlayerId: string;
  position: Vector2;
  recoveryEndsAtMs: number;
}

export interface ShoveResolution {
  /** The requester's acknowledgement. */
  result: ShoveResult;
  /** Present only when this call committed a shove. */
  effect: ShoveEffect | null;
  /** Present only when this call committed a shove; broadcast it to the room. */
  landed: ShoveLanded | null;
  /** True when a duplicate request ID replayed an earlier committed decision. */
  replayed: boolean;
}

export interface ShoveAuthorityOptions {
  /** Blocks reach. Defaults to the shared shelf collision. */
  collision?: readonly CollisionRectangle[];
  /** Blocks knockback travel. Defaults to shelves plus cart footprints. */
  obstacles?: readonly CollisionRectangle[];
}

interface ShovePlayer {
  id: string;
  cooldownEndsAtMs: number;
  tokens: number;
  tokensRefilledAtMs: number;
  /** Committed decisions only, keyed by request ID, so a resend replays instead of reapplying. */
  committed: Map<string, ShoveResult>;
}

export const SHOVE_REJECTION_MESSAGES: Record<ShoveRejectionReason, string> = {
  INVALID_PAYLOAD: 'That shove request was malformed',
  NOT_IN_MATCH: 'You are not part of an active match',
  INVALID_PHASE: 'Shoving is closed outside the looting phase',
  ON_COOLDOWN: 'Shove is still recharging',
  RECOVERING: 'You are still recovering from a shove',
  NO_TARGET_IN_CONE: 'Nobody in front of you to shove',
  UNKNOWN_TARGET: 'That player is not in this match',
  SELF_TARGET: 'You cannot shove yourself',
  TARGET_UNAVAILABLE: 'That player cannot be shoved right now',
  OUT_OF_RANGE: 'Get closer to shove',
  OUT_OF_CONE: 'Turn to face them and shove again',
  NO_LINE_OF_ACCESS: 'A shelf is in the way',
  RATE_LIMITED: 'Slow down · too many shoves at once',
};

/**
 * Authoritative owner of shove cooldowns and decisions. Every resolution runs to
 * completion synchronously on the Node event loop, so a mutual exchange is
 * serialized: the first request to arrive lands, and it puts its target into
 * recovery before that target's own request is ever read.
 */
export class MatchShoveAuthority {
  readonly roomCode: string;
  private readonly players = new Map<string, ShovePlayer>();
  private readonly collision: readonly CollisionRectangle[];
  private readonly obstacles: readonly CollisionRectangle[];
  private sequence = 0;

  constructor(roomCode: string, options: ShoveAuthorityOptions = {}) {
    this.roomCode = roomCode;
    this.collision = options.collision ?? GROCERY_STORE_COLLISION;
    this.obstacles = options.obstacles ?? SHOVE_OBSTACLES;
  }

  removePlayer(playerId: string): void {
    this.players.delete(playerId);
  }

  resolve(context: ShoveContext): ShoveResolution {
    const shover = context.participants.find((participant) => participant.id === context.shoverId);
    if (!shover || !shover.eligible) return this.rejectWithoutPlayer(context, 'NOT_IN_MATCH');

    const player = this.playerRecord(context.shoverId);
    // Checked before the rate limiter so a duplicate delivery never burns a token.
    const committed = player.committed.get(context.request.requestId);
    if (committed) return { result: committed, effect: null, landed: null, replayed: true };

    if (!this.shovingOpen(context)) return this.reject(player, context, 'INVALID_PHASE');
    if (!this.takeToken(player, context.serverNowMs)) return this.reject(player, context, 'RATE_LIMITED');
    if (context.serverNowMs < shover.recoveringUntilMs) return this.reject(player, context, 'RECOVERING');
    if (context.serverNowMs < player.cooldownEndsAtMs) return this.reject(player, context, 'ON_COOLDOWN');

    const chosen = this.chooseTarget(context, shover);
    if ('reason' in chosen) return this.reject(player, context, chosen.reason);
    return this.commit(player, context, shover, chosen.target);
  }

  private playerRecord(playerId: string): ShovePlayer {
    const existing = this.players.get(playerId);
    if (existing) return existing;
    const created: ShovePlayer = {
      id: playerId,
      cooldownEndsAtMs: 0,
      tokens: SHOVE.burstCapacity,
      tokensRefilledAtMs: 0,
      committed: new Map(),
    };
    this.players.set(playerId, created);
    return created;
  }

  private shovingOpen(context: ShoveContext): boolean {
    if (context.phase !== 'LOOTING') return false;
    return context.phaseEndsAtMs === null || context.serverNowMs < context.phaseEndsAtMs;
  }

  private takeToken(player: ShovePlayer, serverNowMs: number): boolean {
    const elapsedSeconds = Math.max(0, (serverNowMs - player.tokensRefilledAtMs) / 1_000);
    player.tokens = Math.min(SHOVE.burstCapacity, player.tokens + elapsedSeconds * SHOVE.refillPerSecond);
    player.tokensRefilledAtMs = serverNowMs;
    if (player.tokens < 1) return false;
    player.tokens -= 1;
    return true;
  }

  /**
   * A nominated target is validated with a specific reason so the HUD can say
   * what went wrong; an omitted one makes the server pick the nearest eligible
   * player it can actually reach.
   */
  private chooseTarget(
    context: ShoveContext,
    shover: ShoveParticipant,
  ): { target: ShoveParticipant } | { reason: ShoveRejectionReason } {
    const nominated = context.request.targetPlayerId;
    if (nominated === undefined) {
      const target = context.participants
        .filter((participant) => participant.id !== shover.id && participant.eligible)
        .filter((participant) => this.reachable(shover, participant))
        .sort((left, right) => distanceBetween(shover.position, left.position)
          - distanceBetween(shover.position, right.position))[0];
      return target ? { target } : { reason: 'NO_TARGET_IN_CONE' };
    }

    if (nominated === shover.id) return { reason: 'SELF_TARGET' };
    const target = context.participants.find((participant) => participant.id === nominated);
    if (!target) return { reason: 'UNKNOWN_TARGET' };
    if (!target.eligible) return { reason: 'TARGET_UNAVAILABLE' };
    if (!isWithinInteractionRadius(shover.position, target.position, SHOVE.rangePixels)) {
      return { reason: 'OUT_OF_RANGE' };
    }
    if (!isWithinFacingCone(shover.position, shover.facing, target.position)) return { reason: 'OUT_OF_CONE' };
    if (!hasLineOfAccess(shover.position, target.position, this.collision)) return { reason: 'NO_LINE_OF_ACCESS' };
    return { target };
  }

  private reachable(shover: ShoveParticipant, target: ShoveParticipant): boolean {
    if (!isWithinInteractionRadius(shover.position, target.position, SHOVE.rangePixels)) return false;
    if (!isWithinFacingCone(shover.position, shover.facing, target.position)) return false;
    return hasLineOfAccess(shover.position, target.position, this.collision);
  }

  /**
   * Knockback runs along the shove direction rather than the shover's facing, so
   * a target caught at the edge of the cone is pushed away from the shover
   * instead of sideways.
   */
  private commit(
    player: ShovePlayer,
    context: ShoveContext,
    shover: ShoveParticipant,
    target: ShoveParticipant,
  ): ShoveResolution {
    const direction = normalizeMovementVector({
      x: target.position.x - shover.position.x,
      y: target.position.y - shover.position.y,
    });
    // Two players standing exactly on top of each other have no direction; push along the facing instead.
    const push = direction.x === 0 && direction.y === 0
      ? normalizeMovementVector(shover.facing)
      : direction;
    const landedPosition = sweepKnockback(target.position, push, SHOVE.knockbackPixels, this.obstacles);
    const recoveryEndsAtMs = Math.floor(context.serverNowMs + SHOVE.recoveryMs);

    player.cooldownEndsAtMs = Math.floor(context.serverNowMs + SHOVE.cooldownMs);
    const result = shoveResultSchema.parse({
      outcome: 'LANDED',
      requestId: context.request.requestId,
      targetPlayerId: target.id,
      cooldownEndsAtMs: player.cooldownEndsAtMs,
    });
    this.rememberCommitted(player, result);

    return {
      result,
      effect: { targetPlayerId: target.id, position: landedPosition, recoveryEndsAtMs },
      landed: shoveLandedSchema.parse({
        sequence: this.sequence++,
        roomCode: this.roomCode,
        shoverPlayerId: shover.id,
        targetPlayerId: target.id,
        direction: push,
        targetPosition: landedPosition,
        knockbackPixels: distanceBetween(target.position, landedPosition),
        recoveryEndsAtMs,
      }),
      replayed: false,
    };
  }

  /**
   * Only committed shoves are remembered. Rejections stay re-evaluable so a
   * legitimate retry after a cooldown or a rate limit is judged on fresh state.
   */
  private rememberCommitted(player: ShovePlayer, result: ShoveResult): void {
    player.committed.set(result.requestId, result);
    while (player.committed.size > SHOVE.historySize) {
      const oldest = player.committed.keys().next();
      if (oldest.done) break;
      player.committed.delete(oldest.value);
    }
  }

  private reject(
    player: ShovePlayer,
    context: ShoveContext,
    reason: ShoveRejectionReason,
  ): ShoveResolution {
    return {
      result: shoveResultSchema.parse({
        outcome: 'REJECTED',
        requestId: context.request.requestId,
        reason,
        message: SHOVE_REJECTION_MESSAGES[reason],
        cooldownEndsAtMs: player.cooldownEndsAtMs,
      }),
      effect: null,
      landed: null,
      replayed: false,
    };
  }

  private rejectWithoutPlayer(context: ShoveContext, reason: ShoveRejectionReason): ShoveResolution {
    return {
      result: shoveResultSchema.parse({
        outcome: 'REJECTED',
        requestId: context.request.requestId,
        reason,
        message: SHOVE_REJECTION_MESSAGES[reason],
        cooldownEndsAtMs: 0,
      }),
      effect: null,
      landed: null,
      replayed: false,
    };
  }
}

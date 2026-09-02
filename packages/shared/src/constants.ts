export const GAME = {
  maxPlayers: 4,
  maxCarriedItems: 4,
  lootingDurationMs: 69_000,
  countdownDurationMs: 3_000,
  roomCodeLength: 6,
  reconnectGraceMs: 15_000,
  abandonedRoomTtlMs: 30 * 60_000,
  walkSpeedPixelsPerSecond: 150,
  sprintSpeedPixelsPerSecond: 235,
  playerCollisionRadiusPixels: 15,
  mapWidthPixels: 1_800,
  mapHeightPixels: 1_200,
} as const;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const NETWORK = {
  simulationTickRateHz: 30,
  snapshotRateHz: 20,
  maxInputRateHz: 30,
  interpolationDelayMs: 100,
} as const;

/**
 * Authoritative interaction limits. Radii are validated against server-owned
 * positions, so a client may narrow its prompt but can never widen its reach.
 */
export const LOOT = {
  itemInteractionRadiusPixels: 64,
  cartInteractionRadiusPixels: 92,
  /** Token bucket sized for deliberate Space presses, not for held-key spam. */
  interactionBurstCapacity: 6,
  interactionRefillPerSecond: 6,
  /** Retained per player so a resent request ID replays its original decision. */
  interactionHistorySize: 32,
} as const;

/**
 * Sprint stamina. Refill is half the drain rate, so sprinting is a budget rather
 * than a default state, and the re-engage floor stops a held Shift from
 * flickering between walk and sprint the moment the bar empties.
 */
export const SPRINT = {
  staminaCapacity: 100,
  drainPerSecond: 12,
  refillPerSecond: 6,
  reengageThresholdUnits: 20,
} as const;

/**
 * Shove limits. Every one of these is validated against the server's own
 * position and facing, so a modified client can widen none of them.
 */
export const SHOVE = {
  rangePixels: 78,
  /** Half-angle of the facing cone, so 60 gives a 120-degree arc in front. */
  coneHalfAngleDegrees: 60,
  cooldownMs: 1_500,
  knockbackPixels: 96,
  /** How long the target's own movement input is ignored after landing. */
  recoveryMs: 400,
  /** Sweep granularity: small steps stop knockback at geometry instead of tunnelling through it. */
  knockbackStepPixels: 4,
  /** Token bucket for spammed requests. Normal cooldown-paced play never reaches it. */
  burstCapacity: 3,
  refillPerSecond: 1,
  /** Retained per player so a resent request ID replays its original decision. */
  historySize: 32,
} as const;

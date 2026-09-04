export const GAME = {
  maxPlayers: 4,
  maxCarriedItems: 4,
  lootingDurationMs: 69_000,
  /**
   * Maximum length of the survival day that follows looting. It is a ceiling
   * rather than a fixed span: the server ends the day early once every player
   * has ended theirs, and ends it for anyone who has not when this elapses.
   */
  survivalDurationMs: 120_000,
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

/**
 * Survival day numbering. The grocery run happens *before* Day 1, so the first
 * day the server opens is Day 1.
 *
 * The number is server-owned: a client renders the day it is given and never
 * derives, increments, or reports one of its own.
 */
export const SURVIVAL = {
  firstDayNumber: 1,
  /**
   * Committed feeding decisions remembered per household, so a resent request
   * ID replays its original decision instead of spending a second item. Larger
   * than the number of items one household could possibly eat in a match.
   */
  consumptionHistorySize: 256,
} as const;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const NETWORK = {
  simulationTickRateHz: 30,
  snapshotRateHz: 20,
  maxInputRateHz: 30,
  interpolationDelayMs: 100,
  /** Stop a held direction if fresh input stops arriving before transport disconnect detection. */
  inputIdleTimeoutMs: 250,
  /** Socket.IO rejects a single decoded message above this limit before event validation. */
  maxPayloadBytes: 16 * 1024,
  /** Per-socket token bucket protecting every inbound event, including malformed events. */
  socketEventBurstCapacity: 120,
  socketEventRefillPerSecond: 60,
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
  /** Larger than every commit one player can make in a 69-second match. */
  interactionHistorySize: 128,
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
  /** Larger than the cooldown-limited shove count in a 69-second match. */
  historySize: 128,
} as const;

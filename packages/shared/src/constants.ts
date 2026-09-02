export const GAME = {
  maxPlayers: 4,
  maxCarriedItems: 4,
  lootingDurationMs: 69_000,
  countdownDurationMs: 3_000,
  roomCodeLength: 6,
  walkSpeedPixelsPerSecond: 150,
  sprintSpeedPixelsPerSecond: 235,
} as const;

export const NETWORK = {
  snapshotRateHz: 20,
  maxInputRateHz: 30,
} as const;

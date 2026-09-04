import { z } from 'zod';
import { GAME, SPRINT, SURVIVAL } from './constants.js';
import { CARRYABLE_CATEGORIES } from './carryable.js';
import { NPC_SPAWN_TABLE } from './npc-table.js';
import { SURVIVAL_STAT_CEILING } from './survival-table.js';

/**
 * Ordered lifecycle. A match runs `LOBBY → COUNTDOWN → LOOTING → SURVIVAL`;
 * `TALLY` remains a valid wire value because the frozen looting result it
 * describes is still committed and replayed, and the final-result phase that
 * follows survival is not designed yet.
 */
export const gamePhaseSchema = z.enum(['LOBBY', 'COUNTDOWN', 'LOOTING', 'SURVIVAL', 'TALLY']);
export const playerConnectionStateSchema = z.enum(['CONNECTED', 'RECONNECTING']);
export const roomCodeSchema = z.string()
  .trim()
  .toUpperCase()
  .length(GAME.roomCodeLength)
  .regex(/^[A-HJ-KM-NP-Z2-9]+$/);

export const vector2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const publicPlayerStateSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().trim().min(1).max(32),
  slot: z.number().int().min(0).max(GAME.maxPlayers - 1),
  isHost: z.boolean(),
  isReady: z.boolean(),
  isConnected: z.boolean(),
  connectionState: playerConnectionStateSchema,
  position: vector2Schema,
});

export const roomPublicStateSchema = z.object({
  code: roomCodeSchema,
  phase: gamePhaseSchema,
  hostPlayerId: z.string().min(1),
  players: z.array(publicPlayerStateSchema).min(1).max(GAME.maxPlayers),
  serverTimeMs: z.number().int().nonnegative(),
  phaseEndsAtMs: z.number().int().nonnegative().nullable(),
});

const itemIdSchema = z.string().min(1).max(64);
const playerIdSchema = z.string().min(1).max(128);
export const cartIdSchema = z.string().regex(new RegExp(`^cart-[0-${GAME.maxPlayers - 1}]$`));

export const lootItemPublicStateSchema = z.strictObject({
  id: itemIdSchema,
  catalogId: z.string().min(1).max(64),
  position: vector2Schema,
  available: z.boolean(),
});

/** Cart contents are public: everyone can see what a physical cart holds. */
export const cartPublicStateSchema = z.strictObject({
  id: cartIdSchema,
  slot: z.number().int().min(0).max(GAME.maxPlayers - 1),
  ownerPlayerId: playerIdSchema.nullable(),
  itemIds: z.array(itemIdSchema),
});

/**
 * Only how full another player's hands are is public, never what is in them.
 * `count` is carry slots consumed rather than items held, so one carried person
 * reports a full four and every client agrees that those hands are full.
 */
export const carriedCountSchema = z.strictObject({
  playerId: playerIdSchema,
  count: z.number().int().min(0).max(GAME.maxCarriedItems),
});

/**
 * Addressed to a single socket, because `carriedItemIds` is that recipient's own
 * private inventory. Sent on match start and after a reconnection.
 */
export const lootSyncSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  roomCode: roomCodeSchema,
  items: z.array(lootItemPublicStateSchema).max(256),
  carts: z.array(cartPublicStateSchema).max(GAME.maxPlayers),
  carriedCounts: z.array(carriedCountSchema).max(GAME.maxPlayers),
  carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
});

/** Compact committed change broadcast to the room; it carries no private inventory. */
export const lootUpdateSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('PICKED_UP'),
    sequence: z.number().int().nonnegative(),
    roomCode: roomCodeSchema,
    playerId: playerIdSchema,
    itemId: itemIdSchema,
    carriedCount: z.number().int().min(0).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    type: z.literal('DEPOSITED'),
    sequence: z.number().int().nonnegative(),
    roomCode: roomCodeSchema,
    playerId: playerIdSchema,
    cartId: cartIdSchema,
    itemIds: z.array(itemIdSchema).min(1).max(GAME.maxCarriedItems),
    cartItemCount: z.number().int().nonnegative(),
    carriedCount: z.number().int().min(0).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    type: z.literal('DROPPED'),
    sequence: z.number().int().nonnegative(),
    roomCode: roomCodeSchema,
    playerId: playerIdSchema,
    itemId: itemIdSchema,
    /** Where it now lies: a dropped carryable stays wherever it was released. */
    position: vector2Schema,
    carriedCount: z.number().int().min(0).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    type: z.literal('RESTOCKED'),
    sequence: z.number().int().nonnegative(),
    roomCode: roomCodeSchema,
    playerId: playerIdSchema,
    itemIds: z.array(itemIdSchema).min(1).max(GAME.maxCarriedItems),
    carriedCount: z.literal(0),
  }),
]);

/** Loot categories plus `people`; a tally can hold both items and recruits. */
export const carryableCategorySchema = z.enum(CARRYABLE_CATEGORIES);

export const tallyItemSchema = z.strictObject({
  id: itemIdSchema,
  catalogId: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  category: carryableCategorySchema,
});

export const tallyCategoryTotalSchema = z.strictObject({
  category: carryableCategorySchema,
  count: z.number().int().nonnegative(),
});

export const tallyPlayerResultSchema = z.strictObject({
  playerId: playerIdSchema,
  displayName: z.string().trim().min(1).max(32),
  slot: z.number().int().min(0).max(GAME.maxPlayers - 1),
  isConnectedAtEnd: z.boolean(),
  items: z.array(tallyItemSchema).max(256),
  categoryTotals: z.array(tallyCategoryTotalSchema).max(CARRYABLE_CATEGORIES.length),
  totalItems: z.number().int().nonnegative(),
});

/** One immutable server decision, broadcast once and replayed verbatim on reconnection. */
export const matchTallySchema = z.strictObject({
  resultId: z.string().min(1).max(128),
  roomCode: roomCodeSchema,
  lootingStartedAtMs: z.number().int().nonnegative(),
  lootingEndedAtMs: z.number().int().nonnegative(),
  durationMs: z.literal(GAME.lootingDurationMs),
  players: z.array(tallyPlayerResultSchema).min(1).max(GAME.maxPlayers),
  categoryTotals: z.array(tallyCategoryTotalSchema).max(CARRYABLE_CATEGORIES.length),
  totalItems: z.number().int().nonnegative(),
});

/**
 * One survival stat, always a current/max pair. `max` belongs to the character
 * that owns it: 100 is the default scale, never a global assumption, so a
 * 120-max character validates exactly as happily as a 100-max one.
 *
 * Every stat points the same way — higher is better, 0 is the worst — so a
 * later rule can sum or compare any two of them without a per-stat sign table.
 */
export const survivalStatSchema = z.strictObject({
  current: z.number().finite().nonnegative().max(SURVIVAL_STAT_CEILING),
  max: z.number().finite().positive().max(SURVIVAL_STAT_CEILING),
}).refine((stat) => stat.current <= stat.max, {
  message: 'Stat current must not exceed its max',
});

/**
 * The six stats every character has. Written out rather than generated so the
 * inferred type names them; `survival.test.ts` asserts these keys stay in step
 * with `SURVIVAL_STAT_KEYS`.
 */
export const survivalStatsSchema = z.strictObject({
  health: survivalStatSchema,
  survival: survivalStatSchema,
  morale: survivalStatSchema,
  strength: survivalStatSchema,
  nutrition: survivalStatSchema,
  hydration: survivalStatSchema,
});

/** A player's own character, or somebody they recruited. Both are one shape. */
export const survivalCharacterKindSchema = z.enum(['MAIN', 'NPC']);

/**
 * One survival character. A main character and a recruited NPC are the same
 * representation, differing only in `kind` and in whether a catalog entry backs
 * them, so no rule downstream needs two code paths to feed or kill somebody.
 *
 * `isAlive` is explicit rather than derived from health, because the overnight
 * death rule kills on combined nutrition and hydration rather than on damage.
 */
export const survivalCharacterSchema = z.strictObject({
  /** Stable for the life of the match: the player id, or the recruited item id. */
  id: z.string().min(1).max(128),
  displayName: z.string().trim().min(1).max(64),
  kind: survivalCharacterKindSchema,
  /** The NPC catalog id backing this person; null for a main character. */
  catalogId: z.string().min(1).max(64).nullable(),
  isAlive: z.boolean(),
  stats: survivalStatsSchema,
  /** Plain daily amounts, not current/max pairs, and per character. */
  dailyNutritionCost: z.number().finite().nonnegative().max(SURVIVAL_STAT_CEILING),
  dailyHydrationCost: z.number().finite().nonnegative().max(SURVIVAL_STAT_CEILING),
}).refine((character) => (character.kind === 'NPC') === (character.catalogId !== null), {
  message: 'Only an NPC character carries a catalog id',
});

/**
 * A deposited item held by a household. Identical to a tally line by design:
 * the day is played from the frozen looting result, so an item keeps the id,
 * label, and category that result already gave it.
 */
export const survivalInventoryItemSchema = tallyItemSchema;

/**
 * One player's household: their own character, the people they personally
 * recruited, and their own deposited items. Households are never merged — each
 * player manages only theirs.
 */
export const survivalHouseholdSchema = z.strictObject({
  playerId: playerIdSchema,
  displayName: z.string().trim().min(1).max(32),
  slot: z.number().int().min(0).max(GAME.maxPlayers - 1),
  /** The main character first, then each recruit in the order it was banked. */
  characters: z.array(survivalCharacterSchema).min(1).max(1 + NPC_SPAWN_TABLE.maxPerMatch),
  /** Kept apart from `characters`: ordinary loot never becomes a person. */
  inventory: z.array(survivalInventoryItemSchema).max(256),
});

/**
 * The server's survival state: one household per player, produced once from the
 * frozen looting result. Read-only to clients — no client event carries any of
 * it, so stats, maxes, daily costs, and alive state cannot be submitted.
 */
export const survivalStateSchema = z.strictObject({
  stateId: z.string().min(1).max(128),
  roomCode: roomCodeSchema,
  /**
   * Which survival day this state describes. Looting happens before Day 1, so
   * the first day the server opens is `SURVIVAL.firstDayNumber`. It is carried
   * on the state rather than counted on the client, so every client in a room
   * renders the same day and none of them can advance it.
   */
  dayNumber: z.number().int().min(SURVIVAL.firstDayNumber),
  /** The authoritative looting deadline the day opened on. */
  startedAtMs: z.number().int().nonnegative(),
  households: z.array(survivalHouseholdSchema).min(1).max(GAME.maxPlayers),
});

/**
 * One household owner's server-owned End Day state. The two strict variants
 * keep an unfinished player from carrying a fabricated completion time/reason.
 */
export const survivalPlayerReadinessSchema = z.discriminatedUnion('hasEnded', [
  z.strictObject({
    playerId: playerIdSchema,
    hasEnded: z.literal(false),
    endedAtMs: z.null(),
    endedBy: z.null(),
  }),
  z.strictObject({
    playerId: playerIdSchema,
    hasEnded: z.literal(true),
    endedAtMs: z.number().int().nonnegative(),
    endedBy: z.enum(['MANUAL', 'TIMEOUT']),
  }),
]);

/** Mutable readiness is separate from the immutable household/stat snapshot. */
export const survivalReadinessStateSchema = z.strictObject({
  roomCode: roomCodeSchema,
  dayNumber: z.number().int().min(SURVIVAL.firstDayNumber),
  startedAtMs: z.number().int().nonnegative(),
  endsAtMs: z.number().int().nonnegative(),
  durationMs: z.literal(GAME.survivalDurationMs),
  players: z.array(survivalPlayerReadinessSchema).min(1).max(GAME.maxPlayers),
  /** Households that may still make survival decisions this day. */
  activePlayerCount: z.number().int().min(0).max(GAME.maxPlayers),
  allPlayersEnded: z.boolean(),
}).superRefine((state, context) => {
  if (state.endsAtMs !== state.startedAtMs + state.durationMs) {
    context.addIssue({ code: 'custom', message: 'Survival readiness must cover one authoritative day' });
  }
  const playerIds = new Set(state.players.map((player) => player.playerId));
  if (playerIds.size !== state.players.length) {
    context.addIssue({ code: 'custom', message: 'Survival readiness player ids must be unique' });
  }
  const activePlayerCount = state.players.filter((player) => !player.hasEnded).length;
  if (state.activePlayerCount !== activePlayerCount) {
    context.addIssue({ code: 'custom', message: 'Active player count must match readiness entries' });
  }
  if (state.allPlayersEnded !== (activePlayerCount === 0)) {
    context.addIssue({ code: 'custom', message: 'All-players-ended must match readiness entries' });
  }
  for (const player of state.players) {
    if (!player.hasEnded) continue;
    if (player.endedAtMs < state.startedAtMs || player.endedAtMs > state.endsAtMs) {
      context.addIssue({ code: 'custom', message: 'End Day time must fall within the authoritative day' });
    }
    if (player.endedBy === 'TIMEOUT' && player.endedAtMs !== state.endsAtMs) {
      context.addIssue({ code: 'custom', message: 'Timeout completion must occur at the deadline' });
    }
  }
});

export const snapshotPlayerStateSchema = z.strictObject({
  id: z.string().min(1).max(128),
  position: vector2Schema,
  /** The effective sprint the server applied, not the Shift the client asked for. */
  sprinting: z.boolean(),
  stamina: z.number().min(0).max(SPRINT.staminaCapacity),
  /** Latched at an empty bar; sprint stays denied until the re-engage floor. */
  exhausted: z.boolean(),
  /** Server clock time until which this player's own input is ignored; null when free. */
  recoveringUntilMs: z.number().int().nonnegative().nullable(),
  acknowledgedInputSequence: z.number().int().min(-1),
});

export const gameSnapshotSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  roomCode: roomCodeSchema,
  phase: gamePhaseSchema,
  serverTimeMs: z.number().int().nonnegative(),
  phaseEndsAtMs: z.number().int().nonnegative().nullable(),
  players: z.array(snapshotPlayerStateSchema).min(1).max(GAME.maxPlayers),
});

export const clientInputSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  clientTimeMs: z.number().int().nonnegative(),
  movement: z.object({
    up: z.boolean(),
    down: z.boolean(),
    left: z.boolean(),
    right: z.boolean(),
  }),
  sprint: z.boolean(),
});

const requestIdSchema = z.string().uuid();

/**
 * Strict on purpose: a modified client cannot smuggle a claimed outcome, a
 * position, or an inventory alongside its intent. `targetId` is optional so
 * `INTERACT` can ask the server to choose the nearest valid target itself.
 */
export const interactionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  action: z.enum(['INTERACT', 'PICK_UP', 'DROP_OFF', 'DROP']),
  targetId: z.string().min(1).max(128).optional(),
});

export const interactionRejectionReasonSchema = z.enum([
  'INVALID_PAYLOAD',
  'NOT_IN_MATCH',
  'INVALID_PHASE',
  'NO_NEARBY_TARGET',
  'OUT_OF_RANGE',
  'NO_LINE_OF_ACCESS',
  'UNKNOWN_TARGET',
  'ITEM_UNAVAILABLE',
  'HANDS_FULL',
  'NEEDS_EMPTY_HANDS',
  'NOT_YOUR_CART',
  'NOTHING_CARRIED',
  'RATE_LIMITED',
]);

/**
 * Every acknowledgement restates the requester's authoritative carried item IDs,
 * so an optimistic client can confirm or roll back from the ack alone.
 */
export const interactionResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('PICKED_UP'),
    requestId: requestIdSchema,
    itemId: itemIdSchema,
    catalogId: z.string().min(1).max(64),
    carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    outcome: z.literal('DEPOSITED'),
    requestId: requestIdSchema,
    cartId: cartIdSchema,
    itemIds: z.array(itemIdSchema).min(1).max(GAME.maxCarriedItems),
    cartItemCount: z.number().int().nonnegative(),
    carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    outcome: z.literal('DROPPED'),
    requestId: requestIdSchema,
    itemId: itemIdSchema,
    catalogId: z.string().min(1).max(64),
    position: vector2Schema,
    carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    outcome: z.literal('REJECTED'),
    requestId: requestIdSchema,
    reason: interactionRejectionReasonSchema,
    message: z.string().min(1),
    carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
  }),
]);

/**
 * Strict, and deliberately carries no direction: the server owns facing, derived
 * from the movement inputs it already validated, so there is no vector to spoof.
 * `targetPlayerId` is only a nomination, and omitting it asks the server to pick
 * the nearest eligible player inside the cone itself.
 */
export const shoveRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetPlayerId: playerIdSchema.optional(),
});

export const shoveRejectionReasonSchema = z.enum([
  'INVALID_PAYLOAD',
  'NOT_IN_MATCH',
  'INVALID_PHASE',
  'ON_COOLDOWN',
  'RECOVERING',
  'NO_TARGET_IN_CONE',
  'UNKNOWN_TARGET',
  'SELF_TARGET',
  'TARGET_UNAVAILABLE',
  'OUT_OF_RANGE',
  'OUT_OF_CONE',
  'NO_LINE_OF_ACCESS',
  'RATE_LIMITED',
]);

/**
 * Every acknowledgement restates the cooldown deadline, so the HUD can show the
 * wait without inferring it from a rejection reason.
 */
export const shoveResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('LANDED'),
    requestId: requestIdSchema,
    targetPlayerId: playerIdSchema,
    cooldownEndsAtMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    outcome: z.literal('REJECTED'),
    requestId: requestIdSchema,
    reason: shoveRejectionReasonSchema,
    message: z.string().min(1),
    cooldownEndsAtMs: z.number().int().nonnegative(),
  }),
]);

/**
 * Broadcast to the room after a committed shove, and the only trigger for shove
 * animation, sound, and HUD feedback. It carries the authoritative post-knockback
 * position so every client agrees on where the target ended up.
 */
export const shoveLandedSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  roomCode: roomCodeSchema,
  shoverPlayerId: playerIdSchema,
  targetPlayerId: playerIdSchema,
  /** Unit vector of the server-owned facing this shove resolved against. */
  direction: vector2Schema,
  targetPosition: vector2Schema,
  /** Actual distance applied, which is shorter than the configured push near geometry. */
  knockbackPixels: z.number().nonnegative(),
  recoveryEndsAtMs: z.number().int().nonnegative(),
});

export const roomCreateRequestSchema = z.strictObject({});
export const roomJoinRequestSchema = z.strictObject({ code: roomCodeSchema });
export const roomLeaveRequestSchema = z.strictObject({});
export const lobbyReadyRequestSchema = z.strictObject({ ready: z.boolean() });
export const lobbyStartRequestSchema = z.strictObject({});
/** Identity, day, deadline, and result are all derived from the authenticated socket. */
export const survivalEndDayRequestSchema = z.strictObject({});

/**
 * One feeding intent, and nothing else: which of your own inventory items, and
 * which of your own characters. Strict on purpose — a modified client cannot
 * smuggle a household, a stat, a restored amount, or a resulting value
 * alongside it, because there is no field here to put one in. Identity comes
 * from the authenticated socket, and what the item does comes from the shared
 * consumable table the server reads.
 */
export const survivalConsumeRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  /** The inventory item instance to spend, not a catalog id and not a count. */
  itemId: itemIdSchema,
  characterId: z.string().min(1).max(128),
});

export const serverErrorCodeSchema = z.enum([
  'INVALID_PAYLOAD',
  'UNAUTHENTICATED',
  'EMAIL_ALREADY_REGISTERED',
  'USERNAME_ALREADY_TAKEN',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'MATCH_ALREADY_STARTED',
  'ALREADY_IN_ROOM',
  'NOT_IN_ROOM',
  'PLAYERS_NOT_READY',
  'INVALID_PHASE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

export const serverErrorSchema = z.object({
  code: serverErrorCodeSchema,
  message: z.string().min(1),
  event: z.string().min(1).optional(),
  requestId: requestIdSchema.optional(),
  retryable: z.boolean(),
});

export const roomCommandResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), room: roomPublicStateSchema.nullable() }),
  z.object({ ok: z.literal(false), error: serverErrorSchema }),
]);

export const survivalEndDayResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), readiness: survivalReadinessStateSchema }),
  z.strictObject({ ok: z.literal(false), error: serverErrorSchema }),
]);

export const survivalConsumeRejectionReasonSchema = z.enum([
  'INVALID_PAYLOAD',
  'NOT_IN_MATCH',
  'INVALID_PHASE',
  'DAY_ALREADY_ENDED',
  'NO_HOUSEHOLD',
  'UNKNOWN_ITEM',
  'NOT_CONSUMABLE',
  'UNKNOWN_CHARACTER',
  'CHARACTER_DEAD',
  'RATE_LIMITED',
]);

/**
 * A committed feed restates the authoritative result — the fed character and
 * the household's remaining inventory — so a client renders what the server
 * decided rather than computing a restoration of its own. It is a restatement,
 * never a submission: the same values only ever travel in this direction.
 */
export const survivalConsumeResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('CONSUMED'),
    requestId: requestIdSchema,
    itemId: itemIdSchema,
    catalogId: z.string().min(1).max(64),
    character: survivalCharacterSchema,
    inventory: z.array(survivalInventoryItemSchema).max(256),
  }),
  z.strictObject({
    outcome: z.literal('REJECTED'),
    requestId: requestIdSchema,
    reason: survivalConsumeRejectionReasonSchema,
    message: z.string().min(1),
  }),
]);

export const roomClosedSchema = z.object({
  code: roomCodeSchema,
  reason: z.enum(['EMPTY', 'EXPIRED']),
});

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('69-seconds-server'),
});

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z.string().min(8).max(128);

// Usernames are lowercased on the way in so uniqueness never depends on the database collation.
export const usernameSchema = z.string().trim().toLowerCase().min(4).max(24).regex(/^[a-z0-9_]+$/);

export const registerRequestSchema = z.strictObject({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

// Login accepts either the username or the email address in a single field.
export const loginRequestSchema = z.strictObject({
  identifier: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(128),
});

export const logoutRequestSchema = z.strictObject({});

export const publicUserSchema = z.object({
  id: z.string().uuid(),
  username: usernameSchema,
  email: emailSchema,
  createdAt: z.string().datetime(),
});

export const authResponseSchema = z.object({ user: publicUserSchema });
export const currentUserResponseSchema = z.object({ user: publicUserSchema });
export const logoutResponseSchema = z.object({ success: z.literal(true) });

export const apiErrorResponseSchema = z.object({
  error: serverErrorSchema.omit({ event: true, requestId: true }),
});

export type GamePhase = z.infer<typeof gamePhaseSchema>;
export type PlayerConnectionState = z.infer<typeof playerConnectionStateSchema>;
export type Vector2 = z.infer<typeof vector2Schema>;
export type PublicPlayerState = z.infer<typeof publicPlayerStateSchema>;
export type RoomPublicState = z.infer<typeof roomPublicStateSchema>;
export type LootItemPublicState = z.infer<typeof lootItemPublicStateSchema>;
export type CartPublicState = z.infer<typeof cartPublicStateSchema>;
export type CarriedCount = z.infer<typeof carriedCountSchema>;
export type LootSync = z.infer<typeof lootSyncSchema>;
export type LootUpdate = z.infer<typeof lootUpdateSchema>;
export type TallyItem = z.infer<typeof tallyItemSchema>;
export type TallyCategoryTotal = z.infer<typeof tallyCategoryTotalSchema>;
export type TallyPlayerResult = z.infer<typeof tallyPlayerResultSchema>;
export type MatchTally = z.infer<typeof matchTallySchema>;
// `SurvivalStat` itself is declared in `survival-table.ts`, the tuning file that
// has no dependencies, so the balance defaults and the wire shape share one name.
export type SurvivalStats = z.infer<typeof survivalStatsSchema>;
export type SurvivalCharacterKind = z.infer<typeof survivalCharacterKindSchema>;
export type SurvivalCharacter = z.infer<typeof survivalCharacterSchema>;
export type SurvivalInventoryItem = z.infer<typeof survivalInventoryItemSchema>;
export type SurvivalHousehold = z.infer<typeof survivalHouseholdSchema>;
export type SurvivalState = z.infer<typeof survivalStateSchema>;
export type SurvivalPlayerReadiness = z.infer<typeof survivalPlayerReadinessSchema>;
export type SurvivalReadinessState = z.infer<typeof survivalReadinessStateSchema>;
export type SnapshotPlayerState = z.infer<typeof snapshotPlayerStateSchema>;
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
export type ClientInput = z.infer<typeof clientInputSchema>;
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;
export type InteractionRejectionReason = z.infer<typeof interactionRejectionReasonSchema>;
export type InteractionResult = z.infer<typeof interactionResultSchema>;
export type ShoveRequest = z.infer<typeof shoveRequestSchema>;
export type ShoveRejectionReason = z.infer<typeof shoveRejectionReasonSchema>;
export type ShoveResult = z.infer<typeof shoveResultSchema>;
export type ShoveLanded = z.infer<typeof shoveLandedSchema>;
export type RoomCreateRequest = z.infer<typeof roomCreateRequestSchema>;
export type RoomJoinRequest = z.infer<typeof roomJoinRequestSchema>;
export type RoomLeaveRequest = z.infer<typeof roomLeaveRequestSchema>;
export type LobbyReadyRequest = z.infer<typeof lobbyReadyRequestSchema>;
export type LobbyStartRequest = z.infer<typeof lobbyStartRequestSchema>;
export type SurvivalEndDayRequest = z.infer<typeof survivalEndDayRequestSchema>;
export type SurvivalEndDayResult = z.infer<typeof survivalEndDayResultSchema>;
export type SurvivalConsumeRequest = z.infer<typeof survivalConsumeRequestSchema>;
export type SurvivalConsumeRejectionReason = z.infer<typeof survivalConsumeRejectionReasonSchema>;
export type SurvivalConsumeResult = z.infer<typeof survivalConsumeResultSchema>;
export type ServerErrorCode = z.infer<typeof serverErrorCodeSchema>;
export type ServerError = z.infer<typeof serverErrorSchema>;
export type RoomCommandResult = z.infer<typeof roomCommandResultSchema>;
export type RoomClosed = z.infer<typeof roomClosedSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

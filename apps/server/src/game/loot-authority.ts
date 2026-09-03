import {
  GAME,
  GROCERY_STORE_CARTS,
  generateLootSpawns,
  LOOT,
  assignedCartIdForSlot,
  cartLabel,
  distanceBetween,
  hasLineOfAccess,
  interactionResultSchema,
  isWithinInteractionRadius,
  lootSyncSchema,
  lootUpdateSchema,
  type CartDefinition,
  type CartId,
  type CollisionRectangle,
  type GamePhase,
  type InteractionRejectionReason,
  type InteractionRequest,
  type InteractionResult,
  type LootSpawnPoint,
  type LootSync,
  type LootUpdate,
  type Vector2,
} from '@69-seconds/shared';

/** An item is in exactly one place: on the shelf, in a pair of hands, or in a cart. */
interface AuthoritativeItem {
  id: string;
  catalogId: string;
  position: Vector2;
  holderPlayerId: string | null;
  cartId: CartId | null;
}

interface AuthoritativeCart {
  id: CartId;
  slot: number;
  position: Vector2;
  ownerPlayerId: string | null;
  itemIds: string[];
}

interface LootPlayer {
  id: string;
  slot: number;
  carried: string[];
  interactionTokens: number;
  tokensRefilledAtMs: number;
  /** Committed decisions only, keyed by request ID, so a resend replays instead of reapplying. */
  committed: Map<string, InteractionResult>;
}

export interface InteractionContext {
  playerId: string;
  position: Vector2;
  phase: GamePhase;
  phaseEndsAtMs: number | null;
  serverNowMs: number;
  request: InteractionRequest;
}

export interface InteractionResolution {
  result: InteractionResult;
  /** Present only when this call changed authoritative state; broadcast it to the room. */
  update: LootUpdate | null;
  /** True when a duplicate request ID replayed an earlier committed decision. */
  replayed: boolean;
}

export interface LootAuthorityOptions {
  /** Defaults to a fresh randomized draw from the shared loot table. */
  spawns?: readonly LootSpawnPoint[];
  carts?: readonly CartDefinition[];
  /** Defaults to the shared store collision, which is the production geometry. */
  collision?: readonly CollisionRectangle[];
}

export interface DepositedLootItem {
  id: string;
  catalogId: string;
}

export const REJECTION_MESSAGES: Record<InteractionRejectionReason, string> = {
  INVALID_PAYLOAD: 'That interaction request was malformed',
  NOT_IN_MATCH: 'You are not part of an active match',
  INVALID_PHASE: 'Interactions are closed outside the looting phase',
  NO_NEARBY_TARGET: 'No item or cart close enough',
  OUT_OF_RANGE: 'Move closer to interact',
  NO_LINE_OF_ACCESS: 'A shelf is in the way',
  UNKNOWN_TARGET: 'That target does not exist in this match',
  ITEM_UNAVAILABLE: 'That item is no longer available',
  HANDS_FULL: 'Hands full · deposit at your assigned cart',
  NOT_YOUR_CART: 'That cart is not assigned to you',
  NOTHING_CARRIED: 'Nothing to deposit · collect an item first',
  RATE_LIMITED: 'Slow down · too many interactions at once',
};

/**
 * Authoritative owner of the match loot set. Every decision runs to completion
 * synchronously on the Node event loop, so two racing pickups are serialized and
 * exactly one of them can observe the item as available.
 */
export class MatchLootAuthority {
  readonly roomCode: string;
  private readonly items = new Map<string, AuthoritativeItem>();
  private readonly carts = new Map<CartId, AuthoritativeCart>();
  private readonly players = new Map<string, LootPlayer>();
  private readonly collision: readonly CollisionRectangle[] | undefined;
  private sequence = 0;

  constructor(
    roomCode: string,
    players: Iterable<{ id: string; slot: number }>,
    options: LootAuthorityOptions = {},
  ) {
    this.roomCode = roomCode;
    this.collision = options.collision;
    for (const spawn of options.spawns ?? generateLootSpawns()) {
      this.items.set(spawn.id, {
        id: spawn.id,
        catalogId: spawn.catalogId,
        position: { x: spawn.x, y: spawn.y },
        holderPlayerId: null,
        cartId: null,
      });
    }
    for (const cart of options.carts ?? GROCERY_STORE_CARTS) {
      this.carts.set(cart.id, {
        id: cart.id,
        slot: cart.slot,
        position: { x: cart.x, y: cart.y },
        ownerPlayerId: null,
        itemIds: [],
      });
    }
    this.synchronizePlayers(players);
  }

  /** Adds newly present players and releases the loot of players who are gone. */
  synchronizePlayers(players: Iterable<{ id: string; slot: number }>): LootUpdate[] {
    const present = new Map([...players].map((player) => [player.id, player.slot]));
    const updates: LootUpdate[] = [];
    for (const playerId of [...this.players.keys()]) {
      if (!present.has(playerId)) {
        const update = this.removePlayer(playerId);
        if (update) updates.push(update);
      }
    }
    for (const [playerId, slot] of present) {
      const existing = this.players.get(playerId);
      if (existing) {
        existing.slot = slot;
      } else {
        this.players.set(playerId, {
          id: playerId,
          slot,
          carried: [],
          interactionTokens: LOOT.interactionBurstCapacity,
          tokensRefilledAtMs: 0,
          committed: new Map(),
        });
      }
      const cart = this.carts.get(assignedCartIdForSlot(slot));
      if (cart) cart.ownerPlayerId = playerId;
    }
    for (const cart of this.carts.values()) {
      if (cart.ownerPlayerId && !present.has(cart.ownerPlayerId)) cart.ownerPlayerId = null;
    }
    return updates;
  }

  /**
   * Removing a player restocks whatever they were still holding. Deposited items
   * stay in the cart so the tally keeps crediting completed work.
   */
  removePlayer(playerId: string): LootUpdate | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    this.players.delete(playerId);
    for (const cart of this.carts.values()) {
      if (cart.ownerPlayerId === playerId) cart.ownerPlayerId = null;
    }
    const restocked = player.carried.filter((itemId) => {
      const item = this.items.get(itemId);
      if (!item || item.holderPlayerId !== playerId) return false;
      item.holderPlayerId = null;
      return true;
    });
    if (restocked.length === 0) return null;
    return lootUpdateSchema.parse({
      type: 'RESTOCKED',
      sequence: this.sequence++,
      roomCode: this.roomCode,
      playerId,
      itemIds: restocked,
      carriedCount: 0,
    });
  }

  resolve(context: InteractionContext): InteractionResolution {
    const player = this.players.get(context.playerId);
    if (!player) {
      return { result: this.reject(context.request.requestId, 'NOT_IN_MATCH', []), update: null, replayed: false };
    }

    // Checked before the rate limiter so a duplicate delivery never burns a token.
    const committed = player.committed.get(context.request.requestId);
    if (committed) return { result: committed, update: null, replayed: true };

    if (!this.interactionsOpen(context)) return this.rejectFor(player, context, 'INVALID_PHASE');
    if (!this.takeInteractionToken(player, context.serverNowMs)) {
      return this.rejectFor(player, context, 'RATE_LIMITED');
    }

    const action = context.request.action;
    const targetId = context.request.targetId;
    if (action === 'PICK_UP') {
      if (!targetId) return this.rejectFor(player, context, 'NO_NEARBY_TARGET');
      return this.pickUp(player, context, targetId);
    }
    if (action === 'DROP_OFF') {
      if (!targetId) return this.rejectFor(player, context, 'NO_NEARBY_TARGET');
      return this.deposit(player, context, targetId);
    }
    return this.interactWithNearest(player, context);
  }

  /** Full authoritative state for one socket, including that player's private hands. */
  syncFor(playerId: string): LootSync {
    return lootSyncSchema.parse({
      sequence: this.sequence++,
      roomCode: this.roomCode,
      items: [...this.items.values()].map((item) => ({
        id: item.id,
        catalogId: item.catalogId,
        position: item.position,
        available: item.holderPlayerId === null && item.cartId === null,
      })),
      carts: [...this.carts.values()].map((cart) => ({
        id: cart.id,
        slot: cart.slot,
        ownerPlayerId: cart.ownerPlayerId,
        itemIds: [...cart.itemIds],
      })),
      carriedCounts: [...this.players.values()].map((player) => ({
        playerId: player.id,
        count: player.carried.length,
      })),
      carriedItemIds: [...(this.players.get(playerId)?.carried ?? [])],
    });
  }

  carriedItemIds(playerId: string): readonly string[] {
    return [...(this.players.get(playerId)?.carried ?? [])];
  }

  cartItemIds(cartId: CartId): readonly string[] {
    return [...(this.carts.get(cartId)?.itemIds ?? [])];
  }

  /** Read-only tally input. Deposits are attributed by the cart's stable room slot. */
  depositedItemsForSlot(slot: number): readonly DepositedLootItem[] {
    const cart = this.carts.get(assignedCartIdForSlot(slot));
    if (!cart) return [];
    return cart.itemIds.flatMap((itemId) => {
      const item = this.items.get(itemId);
      return item ? [{ id: item.id, catalogId: item.catalogId }] : [];
    });
  }

  private reachableThroughGeometry(from: Vector2, to: Vector2): boolean {
    return this.collision ? hasLineOfAccess(from, to, this.collision) : hasLineOfAccess(from, to);
  }

  private interactionsOpen(context: InteractionContext): boolean {
    if (context.phase !== 'LOOTING') return false;
    return context.phaseEndsAtMs === null || context.serverNowMs < context.phaseEndsAtMs;
  }

  private takeInteractionToken(player: LootPlayer, serverNowMs: number): boolean {
    const elapsedSeconds = Math.max(0, (serverNowMs - player.tokensRefilledAtMs) / 1_000);
    player.interactionTokens = Math.min(
      LOOT.interactionBurstCapacity,
      player.interactionTokens + elapsedSeconds * LOOT.interactionRefillPerSecond,
    );
    player.tokensRefilledAtMs = serverNowMs;
    if (player.interactionTokens < 1) return false;
    player.interactionTokens -= 1;
    return true;
  }

  private interactWithNearest(player: LootPlayer, context: InteractionContext): InteractionResolution {
    const item = this.nearestReachableItem(context.position);
    if (item) return this.pickUp(player, context, item.id);
    const cart = this.nearestReachableCart(context.position);
    if (cart) return this.deposit(player, context, cart.id);
    return this.rejectFor(player, context, 'NO_NEARBY_TARGET');
  }

  private pickUp(player: LootPlayer, context: InteractionContext, itemId: string): InteractionResolution {
    const item = this.items.get(itemId);
    if (!item) return this.rejectFor(player, context, 'UNKNOWN_TARGET');
    if (!isWithinInteractionRadius(context.position, item.position, LOOT.itemInteractionRadiusPixels)) {
      return this.rejectFor(player, context, 'OUT_OF_RANGE');
    }
    if (!this.reachableThroughGeometry(context.position, item.position)) {
      return this.rejectFor(player, context, 'NO_LINE_OF_ACCESS');
    }
    // The availability read and the claim below happen with no await between them.
    if (item.holderPlayerId !== null || item.cartId !== null) {
      return this.rejectFor(player, context, 'ITEM_UNAVAILABLE');
    }
    if (player.carried.length >= GAME.maxCarriedItems) {
      return this.rejectFor(player, context, 'HANDS_FULL');
    }

    item.holderPlayerId = player.id;
    player.carried.push(item.id);
    const result = interactionResultSchema.parse({
      outcome: 'PICKED_UP',
      requestId: context.request.requestId,
      itemId: item.id,
      catalogId: item.catalogId,
      carriedItemIds: [...player.carried],
    });
    this.rememberCommitted(player, result);
    return {
      result,
      update: lootUpdateSchema.parse({
        type: 'PICKED_UP',
        sequence: this.sequence++,
        roomCode: this.roomCode,
        playerId: player.id,
        itemId: item.id,
        carriedCount: player.carried.length,
      }),
      replayed: false,
    };
  }

  private deposit(player: LootPlayer, context: InteractionContext, cartId: string): InteractionResolution {
    const cart = this.carts.get(cartId as CartId);
    if (!cart) return this.rejectFor(player, context, 'UNKNOWN_TARGET');
    if (cart.slot !== player.slot) return this.rejectFor(player, context, 'NOT_YOUR_CART');
    if (!isWithinInteractionRadius(context.position, cart.position, LOOT.cartInteractionRadiusPixels)) {
      return this.rejectFor(player, context, 'OUT_OF_RANGE');
    }
    if (!this.reachableThroughGeometry(context.position, cart.position)) {
      return this.rejectFor(player, context, 'NO_LINE_OF_ACCESS');
    }
    if (player.carried.length === 0) return this.rejectFor(player, context, 'NOTHING_CARRIED');

    const deposited = [...player.carried];
    for (const itemId of deposited) {
      const item = this.items.get(itemId);
      if (!item) continue;
      item.holderPlayerId = null;
      item.cartId = cart.id;
      cart.itemIds.push(item.id);
    }
    player.carried = [];
    const result = interactionResultSchema.parse({
      outcome: 'DEPOSITED',
      requestId: context.request.requestId,
      cartId: cart.id,
      itemIds: deposited,
      cartItemCount: cart.itemIds.length,
      carriedItemIds: [],
    });
    this.rememberCommitted(player, result);
    return {
      result,
      update: lootUpdateSchema.parse({
        type: 'DEPOSITED',
        sequence: this.sequence++,
        roomCode: this.roomCode,
        playerId: player.id,
        cartId: cart.id,
        itemIds: deposited,
        cartItemCount: cart.itemIds.length,
        carriedCount: 0,
      }),
      replayed: false,
    };
  }

  private nearestReachableItem(position: Vector2): AuthoritativeItem | undefined {
    return [...this.items.values()]
      .filter((item) => item.holderPlayerId === null && item.cartId === null)
      .filter((item) => isWithinInteractionRadius(position, item.position, LOOT.itemInteractionRadiusPixels))
      .filter((item) => this.reachableThroughGeometry(position, item.position))
      .sort((left, right) => distanceBetween(position, left.position) - distanceBetween(position, right.position))[0];
  }

  private nearestReachableCart(position: Vector2): AuthoritativeCart | undefined {
    return [...this.carts.values()]
      .filter((cart) => isWithinInteractionRadius(position, cart.position, LOOT.cartInteractionRadiusPixels))
      .filter((cart) => this.reachableThroughGeometry(position, cart.position))
      .sort((left, right) => distanceBetween(position, left.position) - distanceBetween(position, right.position))[0];
  }

  /**
   * Only committed decisions are remembered. Rejections stay re-evaluable so a
   * legitimate retry after a rate limit or a phase edge is judged on fresh state.
   */
  private rememberCommitted(player: LootPlayer, result: InteractionResult): void {
    player.committed.set(result.requestId, result);
    while (player.committed.size > LOOT.interactionHistorySize) {
      const oldest = player.committed.keys().next();
      if (oldest.done) break;
      player.committed.delete(oldest.value);
    }
  }

  private rejectFor(
    player: LootPlayer,
    context: InteractionContext,
    reason: InteractionRejectionReason,
  ): InteractionResolution {
    return {
      result: this.reject(context.request.requestId, reason, player.carried, player.slot),
      update: null,
      replayed: false,
    };
  }

  private reject(
    requestId: string,
    reason: InteractionRejectionReason,
    carriedItemIds: readonly string[],
    slot?: number,
  ): InteractionResult {
    const message = reason === 'NOT_YOUR_CART' && slot !== undefined
      ? `Wrong cart · yours is ${cartLabel(assignedCartIdForSlot(slot))}`
      : REJECTION_MESSAGES[reason];
    return interactionResultSchema.parse({
      outcome: 'REJECTED',
      requestId,
      reason,
      message,
      carriedItemIds: [...carriedItemIds],
    });
  }
}

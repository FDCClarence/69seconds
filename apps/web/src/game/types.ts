export type DebugAction = 'SHOVE';

export interface CarryHudItem {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
}

export interface CarryHudState {
  carriedItems: readonly CarryHudItem[];
  depositedCount: number;
}

export interface GameFeedback {
  kind: 'PICKUP_SUCCEEDED' | 'DEPOSIT_SUCCEEDED' | 'HANDS_FULL' | 'ITEM_UNAVAILABLE' | 'INVALID_CART' | 'CART_EMPTY' | 'NO_NEARBY_TARGET' | 'RESET' | 'SHOVE_DEBUG';
  message: string;
}

export interface GroceryGameCallbacks {
  onAction?: (action: DebugAction) => void;
  onFeedback?: (feedback: GameFeedback) => void;
  onInventoryChange?: (inventory: CarryHudState) => void;
  onReady?: () => void;
  /** Stable room slot today; server-assigned cart ownership remains authoritative later. */
  assignedCartSlot?: number;
  localPlayerId?: string;
  initialPhase?: GamePhase;
  roomCode?: string;
  initialPlayers?: readonly PublicPlayerState[];
  sendInput?: (movement: MovementInput, sprint: boolean) => ClientInput | null;
  subscribeSnapshots?: (listener: (snapshot: GameSnapshot) => void) => () => void;
  onPhaseChange?: (phase: GamePhase) => void;
}

export interface DestroyableGame {
  destroy(removeCanvas: boolean): void;
}

export type GroceryGameFactory = (
  parent: HTMLElement,
  callbacks: GroceryGameCallbacks,
) => DestroyableGame;
import type { ClientInput, GamePhase, GameSnapshot, MovementInput, PublicPlayerState } from '@69-seconds/shared';

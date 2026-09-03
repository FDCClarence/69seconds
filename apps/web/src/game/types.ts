/** Real gameplay actions a key press can request. */
export type GameAction = 'INTERACT' | 'SHOVE' | 'DROP';

export interface CarryHudItem {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
  /** Item art, or null when this item has none yet and renders a `?` chip. */
  imageUrl: string | null;
  /** Carry slots this one occupies: 1 for loot, every slot for a person. */
  slotCost: number;
  isNpc: boolean;
  /**
   * How to crop `imageUrl` down to the figure for an NPC whose source art sits
   * inside a large transparent margin; null for ordinary item art.
   */
  crop: NpcSpriteCrop | null;
  /** True while this slot is an unacknowledged prediction. */
  pending: boolean;
}

export interface CarryHudState {
  carriedItems: readonly CarryHudItem[];
  /** Slots the carried set consumes, which is what makes hands "full". */
  slotsUsed: number;
  depositedCount: number;
  synchronized: boolean;
}

/** Locally predicted sprint and shove readiness, corrected by every snapshot. */
export interface SprintHudState {
  /** Remaining stamina as a fraction of the full bar, 0 to 1. */
  fraction: number;
  sprinting: boolean;
  /** Latched at an empty bar; sprint stays denied until the re-engage floor. */
  exhausted: boolean;
  /** 0 while ready to shove, rising to 1 immediately after a landed shove. */
  shoveCooldownFraction: number;
  /** True while a shove has this player's own input frozen. */
  recovering: boolean;
}

/** Server-decided outcomes plus the purely local presentation notices. */
export type GameFeedbackKind =
  | 'PICKED_UP'
  | 'DEPOSITED'
  | 'DROPPED'
  | InteractionRejectionReason
  | ShoveRejectionReason
  | 'SHOVE_LANDED'
  | 'SHOVE_TAKEN'
  | 'SPRINT_EXHAUSTED'
  | 'DESYNCHRONIZED';

export interface GameFeedback {
  kind: GameFeedbackKind;
  message: string;
}

export interface GroceryGameCallbacks {
  onFeedback?: (feedback: GameFeedback) => void;
  onInventoryChange?: (inventory: CarryHudState) => void;
  onSprintChange?: (sprint: SprintHudState) => void;
  onReady?: () => void;
  /** Stable room slot; the server derives assigned cart ownership from the same slot. */
  assignedCartSlot?: number;
  localPlayerId?: string;
  initialPhase?: GamePhase;
  roomCode?: string;
  initialPlayers?: readonly PublicPlayerState[];
  sendInput?: (movement: MovementInput, sprint: boolean) => ClientInput | null;
  subscribeSnapshots?: (listener: (snapshot: GameSnapshot) => void) => () => void;
  /** Requests an interaction and resolves with the server's authoritative decision. */
  requestInteraction?: (request: InteractionRequest) => Promise<InteractionResult>;
  /** Requests a shove and resolves with the server's authoritative decision. */
  requestShove?: (request: ShoveRequest) => Promise<ShoveResult>;
  subscribeLootSync?: (listener: (sync: LootSync) => void) => () => void;
  subscribeLootUpdates?: (listener: (update: LootUpdate) => void) => () => void;
  subscribeShoveLanded?: (listener: (event: ShoveLanded) => void) => () => void;
  onPhaseChange?: (phase: GamePhase) => void;
  getBindings?: () => InputBindings;
  subscribeBindings?: (listener: (bindings: InputBindings) => void) => () => void;
  prefersReducedMotion?: () => boolean;
}

export interface DestroyableGame {
  destroy(removeCanvas: boolean): void;
}

export type GroceryGameFactory = (
  parent: HTMLElement,
  callbacks: GroceryGameCallbacks,
) => DestroyableGame;
import type {
  ClientInput,
  GamePhase,
  GameSnapshot,
  InteractionRejectionReason,
  InteractionRequest,
  InteractionResult,
  LootSync,
  LootUpdate,
  MovementInput,
  NpcSpriteCrop,
  PublicPlayerState,
  ShoveLanded,
  ShoveRejectionReason,
  ShoveRequest,
  ShoveResult,
} from '@69-seconds/shared';
import type { InputBindings } from './input/key-bindings.js';

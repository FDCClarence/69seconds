import Phaser from 'phaser';
import {
  LOOT,
  NETWORK,
  PLAYER_SPAWN_POSITIONS,
  SHOVE,
  SPRINT,
  assignedCartIdForSlot,
  cartLabel,
  hasLineOfAccess,
  initialSprintState,
  isMoving,
  isWithinFacingCone,
  isWithinInteractionRadius,
  LOOT_CATALOG,
  NPC_CATALOG,
  canCarrySlots,
  carryableSlotCost,
  findCarryableEntry,
  findNpcCatalogEntry,
  lootImageUrl,
  movementAxis,
  npcImageUrl,
  npcSpriteCrop,
  movementVelocity,
  normalizeMovementVector,
  resolveSprint,
  simulatePlayerMovement,
  type CartId,
  type ClientInput,
  type GamePhase,
  type CarryableEntry,
  type GameSnapshot,
  type InteractionRequest,
  type InteractionResult,
  type NpcCatalogEntry,
  type ShoveLanded,
  type ShoveRequest,
  type SprintState,
  type Vector2,
} from '@69-seconds/shared';
import { PlayerEntity } from '../entities/player-entity.js';
import { GameInput } from '../input/game-input.js';
import { DEFAULT_INPUT_BINDINGS, bindingLabel, type InputBindings } from '../input/key-bindings.js';
import { RemoteInterpolationBuffer } from '../network/interpolation.js';
import {
  applyInteractionResult,
  applyLootSync,
  applyLootUpdate,
  cartById,
  createLootView,
  isItemVisible,
  lastCarriedItemId,
  predictPickup,
  predictedCarriedItemIds,
  predictedSlotsUsed,
  rollbackPickup,
  visibleItems,
  type LootView,
  type LootViewItem,
} from '../network/loot-view.js';
import { reconcilePredictedState } from '../network/prediction.js';
import { newRequestId } from '../../request-id.js';
import {
  GENERATED_GROCERY_STORE_MAP,
  STORE_OBJECT_LAYER,
  STORE_VISUAL_LAYERS,
  type StoreCart,
} from '../maps/grocery-store-placeholder-map.js';
import type { GameFeedback, GroceryGameCallbacks, SprintHudState } from '../types.js';

const MAP_WIDTH = GENERATED_GROCERY_STORE_MAP.width;
const MAP_HEIGHT = GENERATED_GROCERY_STORE_MAP.height;
const SHELF_TEXTURE = 'prototype-shelf';
/** On-map footprint of an item marker, in world pixels. */
const LOOT_MARKER_SIZE = 40;
/** Small presentational lift that makes loot read as hovering over the floor. */
const LOOT_HOVER_BASELINE = -3;
const LOOT_HOVER_HEIGHT = 10;
/**
 * On-map height of a person, in world pixels. Every NPC is drawn to this height
 * from their trimmed art, so a wide sprite (Clarence and his wheelchair) reads
 * as wide rather than as tall, and nobody's transparent margin sets their size.
 */
const NPC_SPRITE_HEIGHT = 54;
/** People stand on the floor and only sway; they are not hovering pickups. */
const NPC_HOVER_BASELINE = 0;
const NPC_HOVER_HEIGHT = 2.5;
/** Frame naming the figure inside an NPC file, excluding its blank margin. */
const NPC_BODY_FRAME = 'body';

interface LootPresentation {
  root: Phaser.GameObjects.Container;
  hoverLayer: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Ellipse;
  bobPeriodMs: number;
  phaseOffset: number;
  hoverBaseline: number;
  hoverHeight: number;
  /** Loot fakes height by shrinking its shadow as it rises; a person does not. */
  liftsShadow: boolean;
}

/** Texture key for one catalog item's art. */
function lootTextureKey(catalogId: string): string {
  return `loot-art-${catalogId}`;
}

/** Texture key for one person's art. */
function npcTextureKey(catalogId: string): string {
  return `npc-art-${catalogId}`;
}

export class GroceryStoreScene extends Phaser.Scene {
  private readonly callbacks: GroceryGameCallbacks;
  private player?: PlayerEntity;
  private controls?: GameInput;
  private feedbackText?: Phaser.GameObjects.Text;
  private promptText?: Phaser.GameObjects.Text;
  private lootView: LootView = createLootView();
  private readonly lootObjects = new Map<string, LootPresentation>();
  private readonly remotePlayers = new Map<string, PlayerEntity>();
  private readonly remoteBuffers = new Map<string, RemoteInterpolationBuffer>();
  private pendingInputs: ClientInput[] = [];
  private phase: GamePhase;
  private fixedAccumulatorMs = 0;
  private lastSnapshotSequence = -1;
  private lastAcknowledgedInputSequence = -1;
  private serverClockOffsetMs = 0;
  private awaitingInteraction = false;
  private awaitingShove = false;
  private sprint: SprintState = initialSprintState();
  private sprinting = false;
  /** Mirrors the server's derived facing: the last non-zero movement direction. */
  private facing: Vector2 = { x: 0, y: 1 };
  private recoveringUntilServerMs = 0;
  private shoveCooldownEndsAtServerMs = 0;
  private lastPublishedSprint = '';
  private publishedExhausted = false;
  private lastSprintTrailAt = 0;
  private bindings: InputBindings;
  private readonly unsubscribes: (() => void)[] = [];
  private stopped = false;

  constructor(callbacks: GroceryGameCallbacks) {
    super('grocery-store-test');
    this.callbacks = callbacks;
    this.phase = callbacks.initialPhase ?? 'COUNTDOWN';
    this.bindings = callbacks.getBindings?.() ?? DEFAULT_INPUT_BINDINGS;
  }

  /**
   * Item art is optional by design: an entry with no file in the catalog, or a
   * file that fails to download, simply falls through to the `?` placeholder in
   * {@link createLootObject}. A missing PNG never blocks a match from starting.
   */
  preload(): void {
    for (const entry of LOOT_CATALOG) {
      const url = lootImageUrl(entry);
      if (url) this.load.image(lootTextureKey(entry.id), url);
    }
    // Portrait art is deliberately NOT loaded here. Preload gates the first
    // frame, and the roster's hand-authored canvases are far heavier than item
    // art, so fetching them up front would delay every match start. They load
    // in the background instead; see `loadNpcArtInBackground`.
  }

  create(): void {
    this.stopped = false;
    this.physics.world.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.cameras.main.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.drawStore();
    const localState = this.callbacks.initialPlayers?.find((player) => player.id === this.callbacks.localPlayerId);
    const fallbackSpawn = PLAYER_SPAWN_POSITIONS[this.callbacks.assignedCartSlot ?? 0]
      ?? STORE_OBJECT_LAYER.playerSpawn;
    const initialPosition = localState?.position.x || localState?.position.y ? localState.position : fallbackSpawn;
    this.player = new PlayerEntity(this, initialPosition.x, initialPosition.y);
    for (const state of this.callbacks.initialPlayers ?? []) {
      if (state.id !== this.callbacks.localPlayerId) {
        this.ensureRemotePlayer(state.id, state.position.x, state.position.y, state.displayName);
      }
    }
    this.controls = new GameInput(this, this.bindings);
    this.publishInventory();
    this.cameras.main.startFollow(this.player, false, 0.075, 0.075);
    this.cameras.main.setBackgroundColor('#132126');
    this.resizeCamera(this.scale.gameSize);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.resizeCamera, this);

    this.feedbackText = this.add.text(24, 24, '', {
      color: '#172126', backgroundColor: '#f6ca61', fontFamily: 'monospace', fontSize: '16px', padding: { x: 10, y: 7 },
    }).setDepth(10_000).setScrollFactor(0).setAlpha(0);
    this.promptText = this.add.text(this.scale.width / 2, this.scale.height - 42, '', {
      color: '#fff8e6', backgroundColor: '#203735', fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold', padding: { x: 12, y: 8 },
    }).setDepth(10_000).setScrollFactor(0).setOrigin(0.5).setAlpha(0);

    const resetInput = () => this.controls?.reset();
    const inputTarget = this.game.canvas.parentElement;
    window.addEventListener('blur', resetInput);
    inputTarget?.addEventListener('game-input-blur', resetInput);
    this.subscribe(this.callbacks.subscribeSnapshots?.((snapshot) => {
      if (this.belongsToRoom(snapshot.roomCode)) this.applySnapshot(snapshot);
    }));
    this.subscribe(this.callbacks.subscribeLootSync?.((sync) => {
      if (!this.belongsToRoom(sync.roomCode)) return;
      this.lootView = applyLootSync(this.lootView, sync);
      this.rebuildLootObjects();
      this.publishInventory();
    }));
    this.subscribe(this.callbacks.subscribeLootUpdates?.((update) => {
      if (!this.belongsToRoom(update.roomCode)) return;
      this.lootView = applyLootUpdate(this.lootView, update);
      if (update.type === 'DROPPED') this.repositionLootObject(update.itemId);
      this.refreshLootVisibility();
      this.publishInventory();
    }));
    this.subscribe(this.callbacks.subscribeShoveLanded?.((event) => {
      if (this.belongsToRoom(event.roomCode)) this.applyShoveLanded(event);
    }));
    this.subscribe(this.callbacks.subscribeBindings?.((bindings) => {
      this.bindings = bindings;
      this.controls?.updateBindings(bindings);
    }));
    this.publishSprint();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.stopped = true;
      window.removeEventListener('blur', resetInput);
      inputTarget?.removeEventListener('game-input-blur', resetInput);
      this.scale.off(Phaser.Scale.Events.RESIZE, this.resizeCamera, this);
      for (const unsubscribe of this.unsubscribes) unsubscribe();
    });
    this.callbacks.onReady?.();
    this.loadNpcArtInBackground();
  }

  override update(time: number, deltaMs: number): void {
    this.updateLootPresentation(time);
    if (!this.player || !this.controls) return;
    const frame = this.controls.read();
    const recovering = this.isRecovering();
    this.fixedAccumulatorMs = Math.min(this.fixedAccumulatorMs + deltaMs, 250);
    const fixedStepMs = 1_000 / NETWORK.simulationTickRateHz;
    while (this.fixedAccumulatorMs >= fixedStepMs) {
      this.fixedAccumulatorMs -= fixedStepMs;
      // The raw Shift goes on the wire; whether it counts as sprinting is the
      // server's call, and this client only predicts the same decision locally.
      const input = this.callbacks.sendInput?.(frame.movement, frame.sprintHeld) ?? null;
      if (input && this.phase === 'LOOTING') {
        this.pendingInputs.push(input);
        if (this.pendingInputs.length > NETWORK.maxInputRateHz * 4) this.pendingInputs.shift();
      }
      if (this.phase !== 'LOOTING') continue;

      const resolved = resolveSprint(
        this.sprint,
        frame.movement,
        frame.sprintHeld && !recovering,
        1 / NETWORK.simulationTickRateHz,
      );
      this.sprint = resolved.state;
      this.sprinting = resolved.sprinting;
      if (recovering) continue;

      if (isMoving(frame.movement)) this.facing = normalizeMovementVector(movementAxis(frame.movement));
      const next = simulatePlayerMovement(
        { x: this.player.x, y: this.player.y },
        frame.movement,
        resolved.sprinting,
        1 / NETWORK.simulationTickRateHz,
      );
      this.player.setPosition(next.x, next.y);
    }
    // A recovering player reads as planted: their own input is going nowhere.
    const velocity = recovering ? { x: 0, y: 0 } : movementVelocity(frame.movement, this.sprinting);
    this.player.move(velocity, this.sprinting && !recovering, this.reducedMotion());
    if (this.sprinting && !recovering) this.playSprintTrail();
    this.interpolateRemotePlayers();
    const action = this.controls.readAction();
    if (this.phase === 'LOOTING' && action === 'INTERACT') void this.interact();
    if (this.phase === 'LOOTING' && action === 'SHOVE') void this.shove();
    if (this.phase === 'LOOTING' && action === 'DROP') void this.dropCarried();
    this.updateInteractionPrompt();
    this.publishSprint();
  }

  /** Estimated server clock, which every cooldown and recovery deadline is stated in. */
  private serverNowMs(): number {
    return Date.now() + this.serverClockOffsetMs;
  }

  private isRecovering(): boolean {
    return this.serverNowMs() < this.recoveringUntilServerMs;
  }

  private subscribe(unsubscribe: (() => void) | undefined): void {
    if (unsubscribe) this.unsubscribes.push(unsubscribe);
  }

  private belongsToRoom(roomCode: string): boolean {
    return !this.callbacks.roomCode || roomCode === this.callbacks.roomCode;
  }

  private applySnapshot(snapshot: GameSnapshot): void {
    if (!this.player || snapshot.sequence <= this.lastSnapshotSequence) return;
    this.lastSnapshotSequence = snapshot.sequence;
    this.serverClockOffsetMs = snapshot.serverTimeMs - Date.now();
    if (this.phase !== snapshot.phase) {
      this.phase = snapshot.phase;
      this.callbacks.onPhaseChange?.(snapshot.phase);
    }
    const local = snapshot.players.find((player) => player.id === this.callbacks.localPlayerId);
    if (local) {
      if (local.acknowledgedInputSequence === -1 && this.lastAcknowledgedInputSequence >= 0) {
        this.pendingInputs = [];
      }
      this.lastAcknowledgedInputSequence = local.acknowledgedInputSequence;
      this.recoveringUntilServerMs = local.recoveringUntilMs ?? 0;
      const reconciliation = reconcilePredictedState(
        local,
        this.pendingInputs,
        local.acknowledgedInputSequence,
        snapshot.phase,
        this.isRecovering(),
      );
      this.pendingInputs = reconciliation.pendingInputs;
      this.sprint = reconciliation.sprint;
      this.sprinting = local.sprinting;
      this.player.setPosition(reconciliation.position.x, reconciliation.position.y);
      this.publishSprint();
    }
    for (const remote of snapshot.players) {
      if (remote.id === this.callbacks.localPlayerId) continue;
      this.ensureRemotePlayer(remote.id, remote.position.x, remote.position.y);
      this.remoteBuffers.get(remote.id)?.push(snapshot.serverTimeMs, remote.position);
    }
    const activeRemoteIds = new Set(snapshot.players
      .filter((remote) => remote.id !== this.callbacks.localPlayerId)
      .map((remote) => remote.id));
    for (const [playerId, remote] of this.remotePlayers) {
      if (activeRemoteIds.has(playerId)) continue;
      remote.destroy();
      this.remotePlayers.delete(playerId);
      this.remoteBuffers.delete(playerId);
    }
  }

  private ensureRemotePlayer(playerId: string, x: number, y: number, displayName?: string): void {
    if (this.remotePlayers.has(playerId)) return;
    const remote = new PlayerEntity(this, x, y).setRemote(displayName ?? 'Rival');
    remote.setData('playerId', playerId);
    this.remotePlayers.set(playerId, remote);
    this.remoteBuffers.set(playerId, new RemoteInterpolationBuffer());
  }

  private interpolateRemotePlayers(): void {
    const renderServerTimeMs = Date.now() + this.serverClockOffsetMs - NETWORK.interpolationDelayMs;
    for (const [playerId, remote] of this.remotePlayers) {
      const position = this.remoteBuffers.get(playerId)?.sample(renderServerTimeMs);
      if (!position) continue;
      const velocity = { x: position.x - remote.x, y: position.y - remote.y };
      remote.setPosition(position.x, position.y);
      remote.move(velocity, false, this.reducedMotion());
    }
  }

  /**
   * Nominates the target this client believes is nearest and lets the server
   * decide. A pickup is predicted immediately and rolled back if refused; a
   * deposit waits for confirmation, because reversing four slots reads worse
   * than a brief pause.
   */
  private async interact(): Promise<void> {
    if (!this.callbacks.requestInteraction || this.awaitingInteraction) return;
    if (!this.lootView.synchronized) {
      this.showFeedback({ kind: 'DESYNCHRONIZED', message: 'Waiting for the match loot state' });
      return;
    }
    const nearestItem = this.nearestReachableItem();
    // Same rule as the prompt: an item that cannot fit must not shadow the cart
    // standing right next to it, or a player carrying a person could never
    // recruit them. With no cart in reach it is still sent, so the server states
    // the honest reason rather than the press doing nothing at all.
    const fittingItem = nearestItem && this.fitsInHands(nearestItem) ? nearestItem : undefined;
    const cart = fittingItem ? undefined : this.nearestReachableCart();
    const item = fittingItem ?? (cart ? undefined : nearestItem);
    const request: InteractionRequest = {
      requestId: newRequestId(),
      action: item ? 'PICK_UP' : cart ? 'DROP_OFF' : 'INTERACT',
      ...(item ? { targetId: item.id } : cart ? { targetId: cart.id } : {}),
    };
    if (item) {
      this.lootView = predictPickup(this.lootView, request.requestId, item.id);
      this.refreshLootVisibility();
      this.publishInventory();
    }

    this.awaitingInteraction = true;
    try {
      const result = await this.callbacks.requestInteraction(request);
      if (this.stopped) return;
      this.lootView = applyInteractionResult(this.lootView, result);
      this.refreshLootVisibility();
      this.publishInventory();
      this.showFeedback(this.feedbackFor(result));
    } catch {
      if (this.stopped) return;
      // No acknowledgement: discard the prediction rather than showing loot we may not hold.
      this.lootView = rollbackPickup(this.lootView, request.requestId);
      this.refreshLootVisibility();
      this.publishInventory();
      this.showFeedback({ kind: 'DESYNCHRONIZED', message: 'The server did not confirm that interaction' });
    } finally {
      this.awaitingInteraction = false;
    }
  }

  /**
   * Puts down the last thing picked up, wherever the player is standing. The
   * server owns the landing spot, so this waits for the acknowledgement rather
   * than predicting: a marker appearing at your feet and then vanishing reads
   * far worse than a marker appearing a moment late.
   */
  private async dropCarried(): Promise<void> {
    if (!this.callbacks.requestInteraction || this.awaitingInteraction) return;
    if (!this.lootView.synchronized) {
      this.showFeedback({ kind: 'DESYNCHRONIZED', message: 'Waiting for the match loot state' });
      return;
    }
    if (lastCarriedItemId(this.lootView) === undefined) {
      this.showFeedback({ kind: 'NOTHING_CARRIED', message: 'Nothing to put down' });
      return;
    }
    const request: InteractionRequest = { requestId: newRequestId(), action: 'DROP' };

    this.awaitingInteraction = true;
    try {
      const result = await this.callbacks.requestInteraction(request);
      if (this.stopped) return;
      this.lootView = applyInteractionResult(this.lootView, result);
      if (result.outcome === 'DROPPED') this.repositionLootObject(result.itemId);
      this.refreshLootVisibility();
      this.publishInventory();
      this.showFeedback(this.feedbackFor(result));
    } catch {
      if (this.stopped) return;
      this.showFeedback({ kind: 'DESYNCHRONIZED', message: 'The server did not confirm that drop' });
    } finally {
      this.awaitingInteraction = false;
    }
  }

  /** Moves one marker to the position the server just gave it. */
  private repositionLootObject(itemId: string): void {
    const item = this.lootView.items[itemId];
    const presentation = this.lootObjects.get(itemId);
    if (!item || !presentation) return;
    presentation.root.setPosition(item.position.x, item.position.y);
    presentation.root.setDepth(1_000 + item.position.y - (presentation.liftsShadow ? 4 : 0));
  }

  /**
   * The swing plays the instant Ctrl is pressed and the cooldown starts
   * optimistically, so a shove reads as immediate. Only the server moves anybody:
   * the acknowledgement replaces the predicted cooldown with the real one, which
   * also rolls it back to zero when the attempt is refused outright.
   */
  private async shove(): Promise<void> {
    if (!this.callbacks.requestShove || this.awaitingShove) return;
    if (this.isRecovering()) {
      this.showFeedback({ kind: 'RECOVERING', message: 'Still recovering from a shove' });
      return;
    }
    if (this.serverNowMs() < this.shoveCooldownEndsAtServerMs) {
      this.showFeedback({ kind: 'ON_COOLDOWN', message: 'Shove is still recharging' });
      return;
    }
    const targetPlayerId = this.nearestShovableTarget();
    const request: ShoveRequest = {
      requestId: newRequestId(),
      ...(targetPlayerId ? { targetPlayerId } : {}),
    };
    this.playShoveSwing();
    this.shoveCooldownEndsAtServerMs = this.serverNowMs() + SHOVE.cooldownMs;
    this.publishSprint();

    this.awaitingShove = true;
    try {
      const result = await this.callbacks.requestShove(request);
      if (this.stopped) return;
      this.shoveCooldownEndsAtServerMs = result.cooldownEndsAtMs;
      this.showFeedback(result.outcome === 'LANDED'
        ? { kind: 'SHOVE_LANDED', message: 'Shove landed' }
        : { kind: result.reason, message: result.message });
    } catch {
      if (this.stopped) return;
      // No acknowledgement: clear the predicted cooldown rather than locking the key.
      this.shoveCooldownEndsAtServerMs = 0;
      this.showFeedback({ kind: 'DESYNCHRONIZED', message: 'The server did not confirm that shove' });
    } finally {
      this.awaitingShove = false;
      if (!this.stopped) this.publishSprint();
    }
  }

  /**
   * Only the local target is corrected here. A remote target is left to the
   * interpolation buffer, which reaches the same authoritative position from the
   * next snapshot without fighting an already-smoothed path.
   */
  private applyShoveLanded(event: ShoveLanded): void {
    this.playShoveImpact(event.targetPosition);
    if (event.targetPlayerId !== this.callbacks.localPlayerId) return;
    this.recoveringUntilServerMs = event.recoveryEndsAtMs;
    // These inputs are being ignored server-side; replaying them would undo the knockback.
    this.pendingInputs = [];
    this.player?.setPosition(event.targetPosition.x, event.targetPosition.y);
    if (!this.reducedMotion()) this.cameras.main.shake(120, 0.0035);
    this.showFeedback({ kind: 'SHOVE_TAKEN', message: 'Shoved · regaining your footing' });
    this.publishSprint();
  }

  /** Mirrors the server's range, cone, and line-of-access checks so the prompt stays honest. */
  private nearestShovableTarget(): string | undefined {
    const from = this.playerPosition();
    if (!from) return undefined;
    return [...this.remotePlayers.entries()]
      .filter(([, remote]) => isWithinInteractionRadius(from, { x: remote.x, y: remote.y }, SHOVE.rangePixels))
      .filter(([, remote]) => isWithinFacingCone(from, this.facing, { x: remote.x, y: remote.y }))
      .filter(([, remote]) => hasLineOfAccess(from, { x: remote.x, y: remote.y }))
      .sort(([, left], [, right]) => this.distanceTo(left) - this.distanceTo(right))[0]?.[0];
  }

  private playShoveSwing(): void {
    if (!this.player) return;
    const arc = this.add.circle(
      this.player.x + this.facing.x * 26,
      this.player.y + this.facing.y * 26,
      16,
      0xf6ca61,
      0.5,
    ).setDepth(1_000 + this.player.y + 5);
    this.tweens.add({ targets: arc, scale: 1.6, alpha: 0, duration: this.reducedMotion() ? 1 : 180, onComplete: () => arc.destroy() });
  }

  private playShoveImpact(position: Vector2): void {
    const burst = this.add.circle(position.x, position.y, 20, 0xe86b49, 0.55)
      .setStrokeStyle(3, 0xfff2cf, 0.9).setDepth(1_000 + position.y + 5);
    this.tweens.add({ targets: burst, scale: 2.1, alpha: 0, duration: this.reducedMotion() ? 1 : 260, onComplete: () => burst.destroy() });
  }

  /** Coalesced so a 60 Hz render loop does not drive a React update every frame. */
  private publishSprint(): void {
    const now = this.serverNowMs();
    const state: SprintHudState = {
      fraction: Math.max(0, Math.min(1, this.sprint.stamina / SPRINT.staminaCapacity)),
      sprinting: this.sprinting,
      exhausted: this.sprint.exhausted,
      shoveCooldownFraction: Math.max(0, Math.min(1, (this.shoveCooldownEndsAtServerMs - now) / SHOVE.cooldownMs)),
      recovering: now < this.recoveringUntilServerMs,
    };
    if (state.exhausted && !this.publishedExhausted) {
      this.showFeedback({ kind: 'SPRINT_EXHAUSTED', message: 'Sprint spent · keep moving at a walk to recover' });
    }
    this.publishedExhausted = state.exhausted;
    const signature = [
      Math.round(state.fraction * 50),
      state.sprinting,
      state.exhausted,
      Math.round(state.shoveCooldownFraction * 20),
      state.recovering,
    ].join('|');
    if (signature === this.lastPublishedSprint) return;
    this.lastPublishedSprint = signature;
    this.callbacks.onSprintChange?.(state);
  }

  private rebuildLootObjects(): void {
    for (const lootObject of this.lootObjects.values()) lootObject.root.destroy();
    this.lootObjects.clear();
    for (const item of Object.values(this.lootView.items)) {
      const presentation = this.createLootObject(item.id, item.catalogId, item.position.x, item.position.y);
      if (presentation) this.lootObjects.set(item.id, presentation);
    }
    this.refreshLootVisibility();
  }

  private refreshLootVisibility(): void {
    for (const [itemId, lootObject] of this.lootObjects) {
      lootObject.root.setVisible(isItemVisible(this.lootView, itemId));
    }
  }

  private updateLootPresentation(time: number): void {
    const reducedMotion = this.reducedMotion();
    for (const lootObject of this.lootObjects.values()) {
      // One sine wave drives both parts of the illusion: as the artwork rises,
      // its floor shadow becomes smaller and lighter; descending reverses it.
      const lift = reducedMotion
        ? 0
        : (Math.sin((time / lootObject.bobPeriodMs) * Math.PI * 2 + lootObject.phaseOffset) + 1) / 2;
      lootObject.hoverLayer.y = lootObject.hoverBaseline - lootObject.hoverHeight * lift;
      if (!lootObject.liftsShadow) continue;
      lootObject.shadow
        .setScale(Phaser.Math.Linear(1, 0.68, lift), Phaser.Math.Linear(1, 0.62, lift))
        .setAlpha(Phaser.Math.Linear(0.42, 0.2, lift));
    }
  }

  private assignedCartId(): CartId {
    const slot = Phaser.Math.Clamp(this.callbacks.assignedCartSlot ?? 0, 0, STORE_OBJECT_LAYER.carts.length - 1);
    return assignedCartIdForSlot(slot);
  }

  /**
   * Fetches portrait art after the match is already playable. People are drawn
   * as named placeholder chips until their file lands, then swapped in place —
   * a person visible immediately and illustrated a moment later beats a match
   * that will not start until megabytes of art arrive.
   */
  private loadNpcArtInBackground(): void {
    const pending = NPC_CATALOG.filter((entry) => !this.textures.exists(npcTextureKey(entry.id)));
    if (pending.length === 0) {
      this.registerNpcBodyFrames();
      return;
    }
    for (const entry of pending) this.load.image(npcTextureKey(entry.id), npcImageUrl(entry));
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      if (this.stopped) return;
      this.registerNpcBodyFrames();
      this.redrawPeople();
    });
    this.load.start();
  }

  /** Rebuilds only the people, leaving every item presentation untouched. */
  private redrawPeople(): void {
    for (const [itemId, presentation] of [...this.lootObjects]) {
      const item = this.lootView.items[itemId];
      if (!item || !findNpcCatalogEntry(item.catalogId)) continue;
      presentation.root.destroy();
      this.lootObjects.delete(itemId);
      const replacement = this.createLootObject(itemId, item.catalogId, item.position.x, item.position.y);
      if (replacement) this.lootObjects.set(itemId, replacement);
    }
    this.refreshLootVisibility();
  }

  /**
   * Defines a trimmed frame per NPC texture so every person can be drawn to one
   * height regardless of how much blank canvas their source file carries. The
   * rect is catalog data, so a portrait in the HUD crops to exactly the same
   * figure this frame shows on the map.
   */
  private registerNpcBodyFrames(): void {
    for (const entry of NPC_CATALOG) {
      const key = npcTextureKey(entry.id);
      if (!this.textures.exists(key)) continue;
      const texture = this.textures.get(key);
      if (texture.has(NPC_BODY_FRAME)) continue;
      texture.add(NPC_BODY_FRAME, 0, entry.content.x, entry.content.y, entry.content.width, entry.content.height);
    }
  }

  private createLootObject(id: string, catalogId: string, x: number, y: number): LootPresentation | undefined {
    const catalog = findCarryableEntry(catalogId);
    if (!catalog) {
      console.warn(`Skipping unrecognized carryable "${catalogId}" — client and server catalogs disagree.`);
      return undefined;
    }
    const npc = catalog.isNpc ? findNpcCatalogEntry(catalogId) : undefined;
    if (npc) return this.createNpcObject(id, npc, x, y);
    const shadow = this.add.ellipse(0, LOOT_MARKER_SIZE / 2 - 2, LOOT_MARKER_SIZE * 0.72, 9, 0x0d1a1c, 0.42);
    const hoveringParts: Phaser.GameObjects.GameObject[] = [];
    const textureKey = lootTextureKey(catalog.id);
    if (this.textures.exists(textureKey)) {
      hoveringParts.push(this.add.image(0, 0, textureKey).setDisplaySize(LOOT_MARKER_SIZE, LOOT_MARKER_SIZE));
    } else {
      // No art for this item yet: a tinted disc carrying a question mark stands
      // in, so an unillustrated item is still visible and still identifiable.
      hoveringParts.push(
        this.add.circle(0, 0, 15, catalog.color).setStrokeStyle(3, 0x213a37),
        this.add.text(0, 0, '?', {
          color: '#213a37', fontFamily: 'monospace', fontSize: '17px', fontStyle: 'bold',
        }).setOrigin(0.5),
        this.add.text(0, -26, catalog.shortLabel, {
          color: '#213a37', fontFamily: 'monospace', fontSize: '11px', fontStyle: 'bold',
        }).setOrigin(0.5),
      );
    }
    const hoverLayer = this.add.container(0, LOOT_HOVER_BASELINE, hoveringParts);
    const sparkle = this.add.star(15, -13, 4, 1, 3.5, 0xfff2b0, 0).setAlpha(0);
    hoverLayer.add(sparkle);

    const root = this.add.container(x, y, [shadow, hoverLayer]).setName(id).setDepth(1_000 + y - 4);
    if (!this.reducedMotion()) {
      this.tweens.add({
        targets: sparkle,
        alpha: 0.9,
        scaleX: 1.25,
        scaleY: 1.25,
        angle: 45,
        duration: 220,
        ease: 'Sine.easeOut',
        yoyo: true,
        hold: 80,
        repeat: -1,
        repeatDelay: Phaser.Math.Between(1_500, 3_800),
        delay: Phaser.Math.Between(300, 1_600),
      });
    }
    return {
      root,
      hoverLayer,
      shadow,
      bobPeriodMs: Phaser.Math.Between(2_500, 3_200),
      phaseOffset: Phaser.Math.FloatBetween(0, Math.PI * 2),
      hoverBaseline: LOOT_HOVER_BASELINE,
      hoverHeight: LOOT_HOVER_HEIGHT,
      liftsShadow: true,
    };
  }

  /**
   * A person standing in an aisle: drawn from their trimmed frame to a fixed
   * height, planted on the floor rather than hovering, and named, because
   * deciding whether Bryne is worth a whole inventory needs the name visible
   * before you commit to the walk back.
   */
  private createNpcObject(id: string, entry: NpcCatalogEntry, x: number, y: number): LootPresentation {
    const textureKey = npcTextureKey(entry.id);
    const drawn = this.textures.exists(textureKey) && this.textures.get(textureKey).has(NPC_BODY_FRAME);
    const width = drawn
      ? NPC_SPRITE_HEIGHT * (entry.content.width / entry.content.height)
      : NPC_SPRITE_HEIGHT * 0.5;
    const shadow = this.add.ellipse(0, 1, Math.max(width * 0.62, 20), 11, 0x0d1a1c, 0.34);
    const standingParts: Phaser.GameObjects.GameObject[] = drawn
      ? [this.add.image(0, -NPC_SPRITE_HEIGHT / 2, textureKey, NPC_BODY_FRAME)
          .setDisplaySize(width, NPC_SPRITE_HEIGHT)]
      : [
        this.add.rectangle(0, -NPC_SPRITE_HEIGHT / 2, width, NPC_SPRITE_HEIGHT, entry.color)
          .setStrokeStyle(3, 0x213a37),
        this.add.text(0, -NPC_SPRITE_HEIGHT / 2, entry.shortLabel, {
          color: '#213a37', fontFamily: 'monospace', fontSize: '12px', fontStyle: 'bold',
        }).setOrigin(0.5),
      ];
    standingParts.push(this.add.text(0, -NPC_SPRITE_HEIGHT - 10, entry.name.toUpperCase(), {
      color: '#fff8dd', backgroundColor: '#2c4a3f', fontFamily: 'monospace',
      fontSize: '9px', fontStyle: 'bold', padding: { x: 4, y: 2 },
    }).setOrigin(0.5));

    const hoverLayer = this.add.container(0, NPC_HOVER_BASELINE, standingParts);
    const root = this.add.container(x, y, [shadow, hoverLayer]).setName(id).setDepth(1_000 + y);
    return {
      root,
      hoverLayer,
      shadow,
      // Slower than loot, so a person reads as breathing rather than bobbing.
      bobPeriodMs: Phaser.Math.Between(3_400, 4_600),
      phaseOffset: Phaser.Math.FloatBetween(0, Math.PI * 2),
      hoverBaseline: NPC_HOVER_BASELINE,
      hoverHeight: NPC_HOVER_HEIGHT,
      liftsShadow: false,
    };
  }

  /** Mirrors the server's radius and line-of-access checks so prompts stay honest. */
  private nearestReachableItem(): LootViewItem | undefined {
    const from = this.playerPosition();
    if (!from) return undefined;
    return visibleItems(this.lootView)
      .filter((item) => isWithinInteractionRadius(from, item.position, LOOT.itemInteractionRadiusPixels))
      .filter((item) => hasLineOfAccess(from, item.position))
      .sort((left, right) => this.distanceTo(left.position) - this.distanceTo(right.position))[0];
  }

  private nearestReachableCart(): StoreCart | undefined {
    const from = this.playerPosition();
    if (!from) return undefined;
    return STORE_OBJECT_LAYER.carts
      .filter((cart) => isWithinInteractionRadius(from, cart, LOOT.cartInteractionRadiusPixels))
      .filter((cart) => hasLineOfAccess(from, cart))
      .sort((left, right) => this.distanceTo(left) - this.distanceTo(right))[0];
  }

  /** Mirrors the server's slot rule, so the prompt never offers a doomed pickup. */
  private fitsInHands(item: LootViewItem): boolean {
    return canCarrySlots(predictedSlotsUsed(this.lootView), carryableSlotCost(item.catalogId));
  }

  /** The person in this player's arms, when they are carrying one. */
  private carriedPerson(): CarryableEntry | undefined {
    for (const itemId of predictedCarriedItemIds(this.lootView)) {
      const entry = findCarryableEntry(this.lootView.items[itemId]?.catalogId ?? '');
      if (entry?.isNpc) return entry;
    }
    return undefined;
  }

  private playerPosition(): { x: number; y: number } | undefined {
    return this.player ? { x: this.player.x, y: this.player.y } : undefined;
  }

  private distanceTo(target: { x: number; y: number }): number {
    const from = this.playerPosition();
    return from ? Phaser.Math.Distance.Between(from.x, from.y, target.x, target.y) : Number.POSITIVE_INFINITY;
  }

  private updateInteractionPrompt(): void {
    if (!this.lootView.synchronized) {
      this.setPrompt('Synchronizing the store with the server');
      return;
    }
    const carried = predictedCarriedItemIds(this.lootView);
    const slotsUsed = predictedSlotsUsed(this.lootView);
    const person = this.carriedPerson();
    const item = this.nearestReachableItem();
    // The cart wins whenever the nearest item cannot fit, because hands that
    // full are hands on their way to deposit, not hands that want a rejection.
    if (item && this.fitsInHands(item)) {
      const catalog = findCarryableEntry(item.catalogId);
      this.setPrompt(catalog?.isNpc
        ? `${bindingLabel(this.bindings.interact)} · carry ${catalog.label} to your cart`
        : `${bindingLabel(this.bindings.interact)} · pick up ${catalog?.label ?? 'item'}`);
      return;
    }
    const cart = this.nearestReachableCart();
    if (cart) {
      if (cart.id !== this.assignedCartId()) this.setPrompt(`WRONG CART · ${cartLabel(cart.id)} is not assigned to you`);
      else if (carried.length === 0) this.setPrompt('YOUR CART · collect an item first');
      else if (person) this.setPrompt(`${bindingLabel(this.bindings.interact)} · recruit ${person.label} into your cart`);
      else this.setPrompt(`${bindingLabel(this.bindings.interact)} · deposit ${carried.length} item(s) in your cart`);
      return;
    }
    if (item) {
      const catalog = findCarryableEntry(item.catalogId);
      if (person) {
        this.setPrompt(`CARRYING ${person.label.toUpperCase()} · ${bindingLabel(this.bindings.drop)} puts them down`);
      } else if (catalog?.isNpc && slotsUsed > 0) {
        this.setPrompt(`HANDS TOO FULL FOR ${catalog.label.toUpperCase()} · bank your loot first`);
      } else {
        this.setPrompt('HANDS FULL · deposit at your cart');
      }
      return;
    }
    if (person) {
      this.setPrompt(`CARRYING ${person.label.toUpperCase()} · take them to your cart`);
      return;
    }
    this.setPrompt('Explore the aisles · the server owns every shelf');
  }

  private setPrompt(text: string): void {
    const shovable = this.phase === 'LOOTING' && !this.isRecovering()
      && this.serverNowMs() >= this.shoveCooldownEndsAtServerMs
      && this.nearestShovableTarget() !== undefined;
    this.writePrompt(shovable ? `${text} · ${bindingLabel(this.bindings.shove)} shove` : text);
  }

  private writePrompt(text: string): void {
    this.promptText?.setText(text).setPosition(this.scale.width / 2, this.scale.height - 42).setAlpha(1);
  }

  private publishInventory(): void {
    const pendingIds = new Set(this.lootView.pendingPickups.map((pending) => pending.itemId));
    const carriedItems = predictedCarriedItemIds(this.lootView).flatMap((itemId) => {
      const item = this.lootView.items[itemId];
      if (!item) return [];
      const catalog = findCarryableEntry(item.catalogId);
      if (!catalog) return [];
      const npc = catalog.isNpc ? findNpcCatalogEntry(item.catalogId) : undefined;
      return [{
        id: item.id,
        label: catalog.label,
        shortLabel: catalog.shortLabel,
        imageUrl: catalog.imageUrl,
        color: `#${catalog.color.toString(16).padStart(6, '0')}`,
        slotCost: catalog.slotCost,
        isNpc: catalog.isNpc,
        crop: npc ? npcSpriteCrop(npc) : null,
        pending: pendingIds.has(item.id),
      }];
    });
    this.callbacks.onInventoryChange?.({
      carriedItems,
      slotsUsed: predictedSlotsUsed(this.lootView),
      depositedCount: cartById(this.lootView, this.assignedCartId())?.itemIds.length ?? 0,
      synchronized: this.lootView.synchronized,
    });
  }

  private feedbackFor(result: InteractionResult): GameFeedback {
    if (result.outcome === 'PICKED_UP') {
      this.playPickupEffect();
      const entry = findCarryableEntry(result.catalogId);
      return {
        kind: 'PICKED_UP',
        message: entry?.isNpc
          ? `Carrying ${entry.label} · take them to your cart`
          : `Picked up ${entry?.label ?? 'item'}`,
      };
    }
    if (result.outcome === 'DEPOSITED') {
      this.playDepositEffect();
      const recruits = result.itemIds
        .map((itemId) => findCarryableEntry(this.lootView.items[itemId]?.catalogId ?? ''))
        .filter((entry) => entry?.isNpc)
        .map((entry) => entry!.label);
      return {
        kind: 'DEPOSITED',
        message: recruits.length > 0
          ? `Recruited ${recruits.join(', ')} · cart holds ${result.cartItemCount}`
          : `Deposited ${result.itemIds.length} item(s) · cart holds ${result.cartItemCount}`,
      };
    }
    if (result.outcome === 'DROPPED') {
      return { kind: 'DROPPED', message: `Put down ${findCarryableEntry(result.catalogId)?.label ?? 'item'}` };
    }
    return { kind: result.reason, message: result.message };
  }

  private showFeedback(feedback: GameFeedback): void {
    this.callbacks.onFeedback?.(feedback);
    this.feedbackText?.setText(feedback.message).setAlpha(1);
    this.time.delayedCall(1_100, () => this.feedbackText?.setAlpha(0));
  }

  private resizeCamera(gameSize: Phaser.Structs.Size): void {
    const minimumZoom = Math.max(gameSize.width / MAP_WIDTH, gameSize.height / MAP_HEIGHT, 1);
    this.cameras.main.setZoom(minimumZoom);
    this.cameras.main.setDeadzone(Math.min(240, gameSize.width * 0.22), Math.min(150, gameSize.height * 0.2));
  }

  private drawStore(): void {
    this.add.rectangle(MAP_WIDTH / 2, MAP_HEIGHT / 2, MAP_WIDTH, MAP_HEIGHT, STORE_VISUAL_LAYERS.floor.color);
    const grid = this.add.graphics().setDepth(1);
    grid.lineStyle(1, STORE_VISUAL_LAYERS.floor.gridColor, 0.55);
    for (let x = 0; x <= MAP_WIDTH; x += STORE_VISUAL_LAYERS.floor.gridSize) grid.lineBetween(x, 0, x, MAP_HEIGHT);
    for (let y = 0; y <= MAP_HEIGHT; y += STORE_VISUAL_LAYERS.floor.gridSize) grid.lineBetween(0, y, MAP_WIDTH, y);
    const border = this.add.graphics().setDepth(4);
    border.lineStyle(28, 0x26423e, 1).strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    border.fillStyle(0xe86b49, 1).fillRect(0, MAP_HEIGHT - 100, MAP_WIDTH, 100);
    border.fillStyle(0xf5c95f, 1).fillRect(0, MAP_HEIGHT - 100, MAP_WIDTH, 10);
    this.add.circle(STORE_OBJECT_LAYER.playerSpawn.x, STORE_OBJECT_LAYER.playerSpawn.y, 56, 0xf6ca61, 0.16)
      .setStrokeStyle(3, 0xd8904c, 0.8).setDepth(2);
    this.add.text(STORE_OBJECT_LAYER.playerSpawn.x, STORE_OBJECT_LAYER.playerSpawn.y + 58, 'CENTRAL SPAWN', {
      color: '#78613a', fontFamily: 'monospace', fontSize: '12px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(3);
    const shelfArt = this.add.graphics();
    shelfArt.fillStyle(0x36544d, 1).fillRoundedRect(0, 0, 260, 72, 8);
    shelfArt.fillStyle(0xf5c95f, 1).fillRect(8, 9, 244, 8);
    shelfArt.fillStyle(0xc85b41, 1);
    for (let x = 18; x < 250; x += 40) shelfArt.fillRoundedRect(x, 25, 25, 34, 4);
    shelfArt.lineStyle(4, 0x213a37, 1).strokeRoundedRect(0, 0, 260, 72, 8);
    shelfArt.generateTexture(SHELF_TEXTURE, 260, 72);
    shelfArt.destroy();
    for (const shelf of STORE_VISUAL_LAYERS.shelves) {
      this.add.ellipse(shelf.x + 5, shelf.y + 31, shelf.width + 18, 32, 0x162c2d, 0.2)
        .setDepth(1_000 + shelf.y + shelf.height / 2 - 2);
      this.add.image(shelf.x, shelf.y, SHELF_TEXTURE).setTint(shelf.tint)
        .setDepth(1_000 + shelf.y + shelf.height / 2);
    }
    for (const cart of STORE_OBJECT_LAYER.carts) this.drawCart(cart);
    this.add.text(MAP_WIDTH / 2, 72, '69 SECONDS · TEST MARKET', {
      color: '#29403c', fontFamily: 'monospace', fontSize: '30px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(5);
    this.add.text(MAP_WIDTH / 2, MAP_HEIGHT - 50, 'CHECKOUT · FOUR ASSIGNED CARTS', {
      color: '#fff7df', fontFamily: 'monospace', fontSize: '22px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(5);
  }

  private drawCart(cart: StoreCart): void {
    const assigned = cart.id === this.assignedCartId();
    const fixtureDepth = 1_000 + cart.y + cart.height / 2;
    const art = this.add.graphics().setDepth(fixtureDepth);
    art.fillStyle(assigned ? 0xf5c95f : 0x9aadb0, 1).fillRoundedRect(cart.x - 55, cart.y - 26, 82, 48, 8);
    art.lineStyle(6, assigned ? 0xe86b49 : 0x587076, 1).lineBetween(cart.x + 26, cart.y - 18, cart.x + 56, cart.y - 48);
    art.fillStyle(0x213a37, 1).fillCircle(cart.x - 32, cart.y + 28, 8).fillCircle(cart.x + 18, cart.y + 28, 8);
    this.add.text(cart.x - 15, cart.y - 2, `${cart.slot + 1}`, {
      color: '#213a37', fontFamily: 'monospace', fontSize: '20px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(fixtureDepth + 1);
    this.add.text(cart.x, cart.y + 48, assigned ? 'YOUR CART' : cart.label.toUpperCase(), {
      color: assigned ? '#9f4237' : '#345059', fontFamily: 'monospace', fontSize: '12px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(fixtureDepth + 1);
  }

  private reducedMotion(): boolean {
    return this.callbacks.prefersReducedMotion?.() ?? false;
  }

  private playSprintTrail(): void {
    if (!this.player || this.reducedMotion() || this.time.now - this.lastSprintTrailAt < 90) return;
    this.lastSprintTrailAt = this.time.now;
    const puff = this.add.circle(this.player.x - this.facing.x * 17, this.player.y - this.facing.y * 17, 6, 0xffe28a, 0.26)
      .setDepth(1_000 + this.player.y - 3);
    this.tweens.add({ targets: puff, scale: 1.8, alpha: 0, duration: 220, onComplete: () => puff.destroy() });
  }

  private playPickupEffect(): void {
    if (!this.player) return;
    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI / 2;
      const spark = this.add.circle(this.player.x, this.player.y, 3, 0xf6ca61, 0.9)
        .setDepth(1_000 + this.player.y + 4);
      this.tweens.add({
        targets: spark,
        x: this.player.x + Math.cos(angle) * 28,
        y: this.player.y + Math.sin(angle) * 22,
        alpha: 0,
        duration: this.reducedMotion() ? 1 : 220,
        onComplete: () => spark.destroy(),
      });
    }
  }

  private playDepositEffect(): void {
    const cart = STORE_OBJECT_LAYER.carts.find((candidate) => candidate.id === this.assignedCartId());
    if (!cart) return;
    const ring = this.add.circle(cart.x, cart.y, 26, 0xd2ec74, 0.18)
      .setStrokeStyle(4, 0xfff1a8, 0.95).setDepth(1_000 + cart.y + cart.height / 2 + 3);
    this.tweens.add({ targets: ring, scale: 2.2, alpha: 0, duration: this.reducedMotion() ? 1 : 320, onComplete: () => ring.destroy() });
    if (!this.reducedMotion()) this.cameras.main.shake(90, 0.0015);
  }
}

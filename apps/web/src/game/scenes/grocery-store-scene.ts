import Phaser from 'phaser';
import {
  GAME,
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
  lootCatalogEntry,
  movementAxis,
  movementVelocity,
  normalizeMovementVector,
  resolveSprint,
  simulatePlayerMovement,
  type CartId,
  type ClientInput,
  type GamePhase,
  type GameSnapshot,
  type InteractionRequest,
  type InteractionResult,
  type ShoveLanded,
  type ShoveRequest,
  type SprintState,
  type Vector2,
} from '@69-seconds/shared';
import { PlayerEntity } from '../entities/player-entity.js';
import { GameInput } from '../input/game-input.js';
import { RemoteInterpolationBuffer } from '../network/interpolation.js';
import {
  applyInteractionResult,
  applyLootSync,
  applyLootUpdate,
  cartById,
  createLootView,
  isItemVisible,
  predictPickup,
  predictedCarriedItemIds,
  rollbackPickup,
  visibleItems,
  type LootView,
  type LootViewItem,
} from '../network/loot-view.js';
import { reconcilePredictedState } from '../network/prediction.js';
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

export class GroceryStoreScene extends Phaser.Scene {
  private readonly callbacks: GroceryGameCallbacks;
  private player?: PlayerEntity;
  private controls?: GameInput;
  private feedbackText?: Phaser.GameObjects.Text;
  private promptText?: Phaser.GameObjects.Text;
  private lootView: LootView = createLootView();
  private readonly lootObjects = new Map<string, Phaser.GameObjects.Container>();
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
  private readonly unsubscribes: (() => void)[] = [];

  constructor(callbacks: GroceryGameCallbacks) {
    super('grocery-store-test');
    this.callbacks = callbacks;
    this.phase = callbacks.initialPhase ?? 'COUNTDOWN';
  }

  create(): void {
    this.physics.world.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.cameras.main.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.drawStore();
    const localState = this.callbacks.initialPlayers?.find((player) => player.id === this.callbacks.localPlayerId);
    const fallbackSpawn = PLAYER_SPAWN_POSITIONS[this.callbacks.assignedCartSlot ?? 0]
      ?? STORE_OBJECT_LAYER.playerSpawn;
    const initialPosition = localState?.position.x || localState?.position.y ? localState.position : fallbackSpawn;
    this.player = new PlayerEntity(this, initialPosition.x, initialPosition.y);
    for (const state of this.callbacks.initialPlayers ?? []) {
      if (state.id !== this.callbacks.localPlayerId) this.ensureRemotePlayer(state.id, state.position.x, state.position.y);
    }
    this.controls = new GameInput(this);
    this.publishInventory();
    this.cameras.main.startFollow(this.player, false, 0.1, 0.1);
    this.cameras.main.setBackgroundColor('#132126');
    this.resizeCamera(this.scale.gameSize);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.resizeCamera, this);

    this.feedbackText = this.add.text(24, 24, '', {
      color: '#172126', backgroundColor: '#f6ca61', fontFamily: 'monospace', fontSize: '16px', padding: { x: 10, y: 7 },
    }).setDepth(40).setScrollFactor(0).setAlpha(0);
    this.promptText = this.add.text(this.scale.width / 2, this.scale.height - 42, '', {
      color: '#fff8e6', backgroundColor: '#203735', fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold', padding: { x: 12, y: 8 },
    }).setDepth(40).setScrollFactor(0).setOrigin(0.5).setAlpha(0);

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
      this.refreshLootVisibility();
      this.publishInventory();
    }));
    this.subscribe(this.callbacks.subscribeShoveLanded?.((event) => {
      if (this.belongsToRoom(event.roomCode)) this.applyShoveLanded(event);
    }));
    this.publishSprint();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener('blur', resetInput);
      inputTarget?.removeEventListener('game-input-blur', resetInput);
      this.scale.off(Phaser.Scale.Events.RESIZE, this.resizeCamera, this);
      for (const unsubscribe of this.unsubscribes) unsubscribe();
    });
    this.callbacks.onReady?.();
  }

  override update(_time: number, deltaMs: number): void {
    if (!this.player || !this.controls) return;
    const frame = this.controls.read();
    const recovering = this.isRecovering();
    this.fixedAccumulatorMs = Math.min(this.fixedAccumulatorMs + deltaMs, 250);
    const fixedStepMs = 1_000 / NETWORK.simulationTickRateHz;
    while (this.fixedAccumulatorMs >= fixedStepMs) {
      this.fixedAccumulatorMs -= fixedStepMs;
      // The raw Shift goes on the wire; whether it counts as sprinting is the
      // server's call, and this client only predicts the same decision locally.
      const input = this.callbacks.sendInput?.(frame.movement, frame.sprinting) ?? null;
      if (input && this.phase === 'LOOTING') {
        this.pendingInputs.push(input);
        if (this.pendingInputs.length > NETWORK.maxInputRateHz * 4) this.pendingInputs.shift();
      }
      if (this.phase !== 'LOOTING') continue;

      const resolved = resolveSprint(
        this.sprint,
        frame.movement,
        frame.sprinting && !recovering,
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
    this.player.move(velocity, this.sprinting && !recovering);
    this.interpolateRemotePlayers();
    const action = this.controls.readAction();
    if (this.phase === 'LOOTING' && action === 'INTERACT') void this.interact();
    if (this.phase === 'LOOTING' && action === 'SHOVE') void this.shove();
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
  }

  private ensureRemotePlayer(playerId: string, x: number, y: number): void {
    if (this.remotePlayers.has(playerId)) return;
    const remote = new PlayerEntity(this, x, y).setAlpha(0.82);
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
      remote.move(velocity, false);
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
    const item = this.nearestReachableItem();
    const cart = item ? undefined : this.nearestReachableCart();
    const request: InteractionRequest = {
      requestId: this.newRequestId(),
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
      this.lootView = applyInteractionResult(this.lootView, result);
      this.refreshLootVisibility();
      this.publishInventory();
      this.showFeedback(this.feedbackFor(result));
    } catch {
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
      requestId: this.newRequestId(),
      ...(targetPlayerId ? { targetPlayerId } : {}),
    };
    this.playShoveSwing();
    this.shoveCooldownEndsAtServerMs = this.serverNowMs() + SHOVE.cooldownMs;
    this.publishSprint();

    this.awaitingShove = true;
    try {
      const result = await this.callbacks.requestShove(request);
      this.shoveCooldownEndsAtServerMs = result.cooldownEndsAtMs;
      this.showFeedback(result.outcome === 'LANDED'
        ? { kind: 'SHOVE_LANDED', message: 'Shove landed' }
        : { kind: result.reason, message: result.message });
    } catch {
      // No acknowledgement: clear the predicted cooldown rather than locking the key.
      this.shoveCooldownEndsAtServerMs = 0;
      this.showFeedback({ kind: 'DESYNCHRONIZED', message: 'The server did not confirm that shove' });
    } finally {
      this.awaitingShove = false;
      this.publishSprint();
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
    this.cameras.main.shake(160, 0.006);
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
    ).setDepth(24);
    this.tweens.add({ targets: arc, scale: 1.6, alpha: 0, duration: 200, onComplete: () => arc.destroy() });
  }

  private playShoveImpact(position: Vector2): void {
    const burst = this.add.circle(position.x, position.y, 20, 0xe86b49, 0.55)
      .setStrokeStyle(3, 0xfff2cf, 0.9).setDepth(25);
    this.tweens.add({ targets: burst, scale: 2.1, alpha: 0, duration: 320, onComplete: () => burst.destroy() });
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
    for (const lootObject of this.lootObjects.values()) lootObject.destroy();
    this.lootObjects.clear();
    for (const item of Object.values(this.lootView.items)) {
      this.lootObjects.set(item.id, this.createLootObject(item.id, item.catalogId, item.position.x, item.position.y));
    }
    this.refreshLootVisibility();
  }

  private refreshLootVisibility(): void {
    for (const [itemId, lootObject] of this.lootObjects) {
      lootObject.setVisible(isItemVisible(this.lootView, itemId));
    }
  }

  private assignedCartId(): CartId {
    const slot = Phaser.Math.Clamp(this.callbacks.assignedCartSlot ?? 0, 0, STORE_OBJECT_LAYER.carts.length - 1);
    return assignedCartIdForSlot(slot);
  }

  private createLootObject(id: string, catalogId: string, x: number, y: number): Phaser.GameObjects.Container {
    const catalog = lootCatalogEntry(catalogId);
    const marker = this.add.circle(0, 0, 15, catalog.color).setStrokeStyle(3, 0x213a37).setDepth(18);
    const tag = this.add.text(0, -28, catalog.shortLabel, {
      color: '#213a37', fontFamily: 'monospace', fontSize: '11px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(18);
    return this.add.container(x, y, [marker, tag]).setName(id).setDepth(18);
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
    const carried = predictedCarriedItemIds(this.lootView).length;
    const item = this.nearestReachableItem();
    if (item) {
      const catalog = lootCatalogEntry(item.catalogId);
      const full = carried >= GAME.maxCarriedItems;
      this.setPrompt(full ? 'HANDS FULL · deposit at your cart' : `SPACE · pick up ${catalog.label}`);
      return;
    }
    const cart = this.nearestReachableCart();
    if (cart) {
      if (cart.id !== this.assignedCartId()) this.setPrompt(`WRONG CART · ${cartLabel(cart.id)} is not assigned to you`);
      else if (carried === 0) this.setPrompt('YOUR CART · collect an item first');
      else this.setPrompt(`SPACE · deposit ${carried} item(s) in your cart`);
      return;
    }
    this.setPrompt('Explore the aisles · the server owns every shelf');
  }

  private setPrompt(text: string): void {
    const shovable = this.phase === 'LOOTING' && !this.isRecovering()
      && this.serverNowMs() >= this.shoveCooldownEndsAtServerMs
      && this.nearestShovableTarget() !== undefined;
    this.writePrompt(shovable ? `${text} · CTRL shove` : text);
  }

  private writePrompt(text: string): void {
    this.promptText?.setText(text).setPosition(this.scale.width / 2, this.scale.height - 42).setAlpha(1);
  }

  private publishInventory(): void {
    const pendingIds = new Set(this.lootView.pendingPickups.map((pending) => pending.itemId));
    const carriedItems = predictedCarriedItemIds(this.lootView).flatMap((itemId) => {
      const item = this.lootView.items[itemId];
      if (!item) return [];
      const catalog = lootCatalogEntry(item.catalogId);
      return [{
        id: item.id,
        label: catalog.label,
        shortLabel: catalog.shortLabel,
        color: `#${catalog.color.toString(16).padStart(6, '0')}`,
        pending: pendingIds.has(item.id),
      }];
    });
    this.callbacks.onInventoryChange?.({
      carriedItems,
      depositedCount: cartById(this.lootView, this.assignedCartId())?.itemIds.length ?? 0,
      synchronized: this.lootView.synchronized,
    });
  }

  private feedbackFor(result: InteractionResult): GameFeedback {
    if (result.outcome === 'PICKED_UP') {
      return { kind: 'PICKED_UP', message: `Picked up ${lootCatalogEntry(result.catalogId).label}` };
    }
    if (result.outcome === 'DEPOSITED') {
      return { kind: 'DEPOSITED', message: `Deposited ${result.itemIds.length} item(s) · cart holds ${result.cartItemCount}` };
    }
    return { kind: result.reason, message: result.message };
  }

  private newRequestId(): string {
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
    // Deterministic fallback for environments without Web Crypto; still unique per press.
    const random = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${random()}${random()}-${random()}-4${random().slice(1)}-8${random().slice(1)}-${random()}${random()}${random()}`;
  }

  private showFeedback(feedback: GameFeedback): void {
    this.callbacks.onFeedback?.(feedback);
    this.feedbackText?.setText(feedback.message).setAlpha(1);
    this.time.delayedCall(1_100, () => this.feedbackText?.setAlpha(0));
  }

  private resizeCamera(gameSize: Phaser.Structs.Size): void {
    const minimumZoom = Math.max(gameSize.width / MAP_WIDTH, gameSize.height / MAP_HEIGHT, 1);
    this.cameras.main.setZoom(minimumZoom);
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
    for (const shelf of STORE_VISUAL_LAYERS.shelves) this.add.image(shelf.x, shelf.y, SHELF_TEXTURE).setTint(shelf.tint).setDepth(10);
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
    const art = this.add.graphics().setDepth(12);
    art.fillStyle(assigned ? 0xf5c95f : 0x9aadb0, 1).fillRoundedRect(cart.x - 55, cart.y - 26, 82, 48, 8);
    art.lineStyle(6, assigned ? 0xe86b49 : 0x587076, 1).lineBetween(cart.x + 26, cart.y - 18, cart.x + 56, cart.y - 48);
    art.fillStyle(0x213a37, 1).fillCircle(cart.x - 32, cart.y + 28, 8).fillCircle(cart.x + 18, cart.y + 28, 8);
    this.add.text(cart.x - 15, cart.y - 2, `${cart.slot + 1}`, {
      color: '#213a37', fontFamily: 'monospace', fontSize: '20px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(13);
    this.add.text(cart.x, cart.y + 48, assigned ? 'YOUR CART' : cart.label.toUpperCase(), {
      color: assigned ? '#9f4237' : '#345059', fontFamily: 'monospace', fontSize: '12px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(13);
  }
}

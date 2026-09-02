import Phaser from 'phaser';
import {
  createLocalLootState,
  lootCatalogEntry,
  resolveLootCommand,
  type CartId,
  type LocalLootState,
  type LootCatalogId,
  type LootCommand,
  type LootCommandResult,
} from '@69-seconds/shared';
import { PlayerEntity } from '../entities/player-entity.js';
import { GameInput } from '../input/game-input.js';
import {
  GENERATED_GROCERY_STORE_MAP,
  STORE_COLLISION_LAYER,
  STORE_OBJECT_LAYER,
  STORE_VISUAL_LAYERS,
  type StoreCart,
} from '../maps/grocery-store-placeholder-map.js';
import type { GameFeedback, GroceryGameCallbacks } from '../types.js';

const MAP_WIDTH = GENERATED_GROCERY_STORE_MAP.width;
const MAP_HEIGHT = GENERATED_GROCERY_STORE_MAP.height;
const SHELF_TEXTURE = 'prototype-shelf';
const LOOT_INTERACTION_RADIUS = 64;
const CART_INTERACTION_RADIUS = 92;

export class GroceryStoreScene extends Phaser.Scene {
  private readonly callbacks: GroceryGameCallbacks;
  private player?: PlayerEntity;
  private controls?: GameInput;
  private feedbackText?: Phaser.GameObjects.Text;
  private promptText?: Phaser.GameObjects.Text;
  private lootState?: LocalLootState;
  private readonly lootObjects = new Map<string, Phaser.GameObjects.Container>();

  constructor(callbacks: GroceryGameCallbacks) {
    super('grocery-store-test');
    this.callbacks = callbacks;
  }

  create(): void {
    this.physics.world.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.cameras.main.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.drawStore();
    const obstacles = this.physics.add.staticGroup();
    for (const shelf of STORE_COLLISION_LAYER) obstacles.create(shelf.x, shelf.y, SHELF_TEXTURE).setVisible(false);
    this.player = new PlayerEntity(this, STORE_OBJECT_LAYER.playerSpawn.x, STORE_OBJECT_LAYER.playerSpawn.y);
    this.physics.add.collider(this.player, obstacles);
    this.controls = new GameInput(this);
    this.resetLoot(false);
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
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener('blur', resetInput);
      inputTarget?.removeEventListener('game-input-blur', resetInput);
      this.scale.off(Phaser.Scale.Events.RESIZE, this.resizeCamera, this);
    });
    this.callbacks.onReady?.();
  }

  override update(): void {
    if (!this.player || !this.controls) return;
    const frame = this.controls.read();
    this.player.move(frame.velocity, frame.sprinting);
    const action = this.controls.readAction();
    if (action === 'INTERACT') this.interact();
    if (action === 'SHOVE') this.showFeedback({ kind: 'SHOVE_DEBUG', message: 'CTRL · shove remains a local debug hook' });
    if (this.controls.readDebugReset()) this.resetLoot(true);
    this.updateInteractionPrompt();
  }

  private interact(): void {
    const item = this.nearestLoot();
    if (item) {
      this.submitLootCommand({ type: 'PICK_UP', itemId: item.id });
      return;
    }
    const cart = this.nearestCart();
    this.submitLootCommand(cart ? { type: 'DEPOSIT', cartId: cart.id } : { type: 'NO_TARGET' });
  }

  /** Local adapter only: Step 8 replaces this resolver with a server acknowledgement. */
  private submitLootCommand(command: LootCommand): void {
    if (!this.lootState) return;
    const resolution = resolveLootCommand(this.lootState, command);
    this.lootState = resolution.state;
    if (resolution.result.type === 'PICKUP_SUCCEEDED') this.lootObjects.get(resolution.result.itemId)?.destroy();
    this.publishInventory();
    this.showFeedback(this.feedbackFor(resolution.result));
  }

  private resetLoot(announce: boolean): void {
    for (const lootObject of this.lootObjects.values()) lootObject.destroy();
    this.lootObjects.clear();
    this.lootState = createLocalLootState(this.assignedCartId(), STORE_OBJECT_LAYER.lootSpawnPoints);
    for (const spawn of STORE_OBJECT_LAYER.lootSpawnPoints) {
      this.lootObjects.set(spawn.id, this.createLootObject(spawn.id, spawn.catalogId, spawn.x, spawn.y));
    }
    this.publishInventory();
    if (announce) this.showFeedback({ kind: 'RESET', message: 'Local loot reset · all shelves restocked' });
  }

  private assignedCartId(): CartId {
    const slot = Phaser.Math.Clamp(this.callbacks.assignedCartSlot ?? 0, 0, STORE_OBJECT_LAYER.carts.length - 1);
    return `cart-${slot}` as CartId;
  }

  private createLootObject(id: string, catalogId: LootCatalogId, x: number, y: number): Phaser.GameObjects.Container {
    const catalog = lootCatalogEntry(catalogId);
    const marker = this.add.circle(0, 0, 15, catalog.color).setStrokeStyle(3, 0x213a37).setDepth(18);
    const tag = this.add.text(0, -28, catalog.shortLabel, {
      color: '#213a37', fontFamily: 'monospace', fontSize: '11px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(18);
    return this.add.container(x, y, [marker, tag]).setName(id).setDepth(18);
  }

  private nearestLoot(): { id: string; catalogId: LootCatalogId } | undefined {
    if (!this.player || !this.lootState) return undefined;
    return STORE_OBJECT_LAYER.lootSpawnPoints
      .filter((spawn) => this.lootState?.loot.find((item) => item.id === spawn.id)?.available)
      .map((spawn) => ({ ...spawn, distance: Phaser.Math.Distance.Between(this.player!.x, this.player!.y, spawn.x, spawn.y) }))
      .filter((spawn) => spawn.distance <= LOOT_INTERACTION_RADIUS)
      .sort((left, right) => left.distance - right.distance)[0];
  }

  private nearestCart(): StoreCart | undefined {
    if (!this.player) return undefined;
    return STORE_OBJECT_LAYER.carts
      .map((cart) => ({ ...cart, distance: Phaser.Math.Distance.Between(this.player!.x, this.player!.y, cart.x, cart.y) }))
      .filter((cart) => cart.distance <= CART_INTERACTION_RADIUS)
      .sort((left, right) => left.distance - right.distance)[0];
  }

  private updateInteractionPrompt(): void {
    const item = this.nearestLoot();
    if (item) {
      const catalog = lootCatalogEntry(item.catalogId);
      const full = this.lootState?.carriedItemIds.length === 4;
      this.setPrompt(full ? 'HANDS FULL · deposit at your cart' : `SPACE · pick up ${catalog.label}`);
      return;
    }
    const cart = this.nearestCart();
    if (cart) {
      if (cart.id !== this.assignedCartId()) this.setPrompt(`WRONG CART · Cart ${cart.slot + 1} is not assigned to you`);
      else if (this.lootState?.carriedItemIds.length === 0) this.setPrompt('YOUR CART · collect an item first');
      else this.setPrompt(`SPACE · deposit ${this.lootState?.carriedItemIds.length ?? 0} item(s) in your cart`);
      return;
    }
    this.setPrompt('Explore the aisles · R resets local loot');
  }

  private setPrompt(text: string): void {
    this.promptText?.setText(text).setPosition(this.scale.width / 2, this.scale.height - 42).setAlpha(1);
  }

  private publishInventory(): void {
    if (!this.lootState) return;
    const carriedItems = this.lootState.carriedItemIds.flatMap((itemId) => {
      const item = this.lootState?.loot.find((candidate) => candidate.id === itemId);
      if (!item) return [];
      const catalog = lootCatalogEntry(item.catalogId);
      return [{ id: item.id, label: catalog.label, shortLabel: catalog.shortLabel, color: `#${catalog.color.toString(16).padStart(6, '0')}` }];
    });
    this.callbacks.onInventoryChange?.({ carriedItems, depositedCount: this.lootState.depositedItemIds.length });
  }

  private feedbackFor(result: LootCommandResult): GameFeedback {
    switch (result.type) {
      case 'PICKUP_SUCCEEDED': return { kind: result.type, message: `Picked up ${this.labelFor(result.itemId)}` };
      case 'DEPOSIT_SUCCEEDED': return { kind: result.type, message: `Deposited ${result.itemIds.length} item(s) in your cart` };
      case 'HANDS_FULL': return { kind: result.type, message: 'Hands full · deposit at your assigned cart' };
      case 'ITEM_UNAVAILABLE': return { kind: result.type, message: 'That item is no longer available' };
      case 'INVALID_CART': return { kind: result.type, message: `Wrong cart · your cart is ${this.assignedCartId().replace('cart-', 'Cart ')}` };
      case 'CART_EMPTY': return { kind: result.type, message: 'Nothing to deposit · collect an item first' };
      case 'NO_NEARBY_TARGET': return { kind: result.type, message: 'No item or cart close enough' };
    }
  }

  private labelFor(itemId: string): string {
    const item = this.lootState?.loot.find((candidate) => candidate.id === itemId);
    return item ? lootCatalogEntry(item.catalogId).label : 'item';
  }

  private showFeedback(feedback: GameFeedback): void {
    if (feedback.kind === 'SHOVE_DEBUG') this.callbacks.onAction?.('SHOVE');
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

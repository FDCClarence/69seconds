import Phaser from 'phaser';
import { GameInput } from '../input/game-input.js';
import { PlayerEntity } from '../entities/player-entity.js';
import type { GroceryGameCallbacks } from '../types.js';

const MAP_WIDTH = 1_800;
const MAP_HEIGHT = 1_200;
const SHELF_TEXTURE = 'prototype-shelf';

const SHELVES = [
  [330, 260], [670, 260], [1_010, 260], [1_350, 260],
  [330, 500], [670, 500], [1_010, 500], [1_350, 500],
  [330, 740], [670, 740], [1_010, 740], [1_350, 740],
] as const;

export class GroceryStoreScene extends Phaser.Scene {
  private readonly callbacks: GroceryGameCallbacks;
  private player?: PlayerEntity;
  private controls?: GameInput;
  private actionText?: Phaser.GameObjects.Text;

  constructor(callbacks: GroceryGameCallbacks) {
    super('grocery-store-test');
    this.callbacks = callbacks;
  }

  create(): void {
    this.physics.world.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.cameras.main.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.drawStore();

    const obstacles = this.physics.add.staticGroup();
    for (const [x, y] of SHELVES) obstacles.create(x, y, SHELF_TEXTURE);

    this.player = new PlayerEntity(this, MAP_WIDTH / 2, MAP_HEIGHT - 180);
    this.physics.add.collider(this.player, obstacles);
    this.controls = new GameInput(this);
    this.cameras.main.startFollow(this.player, false, 0.1, 0.1);
    this.cameras.main.setBackgroundColor('#132126');
    this.resizeCamera(this.scale.gameSize);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.resizeCamera, this);

    this.actionText = this.add.text(24, 24, '', {
      color: '#172126',
      backgroundColor: '#f6ca61',
      fontFamily: 'monospace',
      fontSize: '16px',
      padding: { x: 10, y: 7 },
    }).setDepth(40).setScrollFactor(0).setAlpha(0);

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
    if (action) this.showDebugAction(action);
  }

  private showDebugAction(action: 'INTERACT' | 'SHOVE'): void {
    this.callbacks.onAction?.(action);
    this.actionText?.setText(action === 'INTERACT' ? 'SPACE · interact hook' : 'CTRL · shove hook').setAlpha(1);
    this.time.delayedCall(650, () => this.actionText?.setAlpha(0));
  }

  private resizeCamera(gameSize: Phaser.Structs.Size): void {
    const minimumZoom = Math.max(gameSize.width / MAP_WIDTH, gameSize.height / MAP_HEIGHT, 1);
    this.cameras.main.setZoom(minimumZoom);
  }

  private drawStore(): void {
    this.add.rectangle(MAP_WIDTH / 2, MAP_HEIGHT / 2, MAP_WIDTH, MAP_HEIGHT, 0xd9ddcf);
    const grid = this.add.graphics().setDepth(1);
    grid.lineStyle(1, 0xbfc7b8, 0.55);
    for (let x = 0; x <= MAP_WIDTH; x += 64) grid.lineBetween(x, 0, x, MAP_HEIGHT);
    for (let y = 0; y <= MAP_HEIGHT; y += 64) grid.lineBetween(0, y, MAP_WIDTH, y);

    const border = this.add.graphics().setDepth(4);
    border.lineStyle(28, 0x26423e, 1).strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    border.fillStyle(0xe86b49, 1).fillRect(0, MAP_HEIGHT - 100, MAP_WIDTH, 100);
    border.fillStyle(0xf5c95f, 1).fillRect(0, MAP_HEIGHT - 100, MAP_WIDTH, 10);

    const shelfArt = this.add.graphics();
    shelfArt.fillStyle(0x36544d, 1).fillRoundedRect(0, 0, 280, 76, 8);
    shelfArt.fillStyle(0xf5c95f, 1).fillRect(8, 9, 264, 8);
    shelfArt.fillStyle(0xc85b41, 1);
    for (let x = 18; x < 270; x += 40) shelfArt.fillRoundedRect(x, 25, 25, 38, 4);
    shelfArt.lineStyle(4, 0x213a37, 1).strokeRoundedRect(0, 0, 280, 76, 8);
    shelfArt.generateTexture(SHELF_TEXTURE, 280, 76);
    shelfArt.destroy();

    this.add.text(MAP_WIDTH / 2, 72, '69 SECONDS · TEST MARKET', {
      color: '#29403c', fontFamily: 'monospace', fontSize: '30px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(5);
    this.add.text(MAP_WIDTH / 2, MAP_HEIGHT - 50, 'CHECKOUT / CENTRAL SPAWN', {
      color: '#fff7df', fontFamily: 'monospace', fontSize: '22px', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(5);
  }
}

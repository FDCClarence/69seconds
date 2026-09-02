import Phaser from 'phaser';
import { GAME, type Vector2 } from '@69-seconds/shared';
import {
  animationState,
  facingFromVelocity,
  facingVector,
  type FacingDirection,
  type PlayerAnimationState,
} from '../animation-state.js';

export const PLAYER_TEXTURE = 'prototype-player';

export function createPlayerTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(PLAYER_TEXTURE)) return;
  const art = scene.add.graphics();
  art.fillStyle(0x15242a, 1).fillEllipse(18, 39, 26, 8);
  art.fillStyle(0xf4c85f, 1).fillRoundedRect(3, 9, 30, 27, 8);
  art.fillStyle(0xe86546, 1).fillCircle(18, 10, 9);
  art.lineStyle(3, 0xf7f3e7, 1).strokeRoundedRect(3, 9, 30, 27, 8);
  art.generateTexture(PLAYER_TEXTURE, 36, 44);
  art.destroy();
}

export class PlayerEntity extends Phaser.Physics.Arcade.Sprite {
  private facing: FacingDirection = 'south';
  private currentAnimation: PlayerAnimationState = 'idle_south';
  private readonly facingMarker: Phaser.GameObjects.Triangle;
  private readonly shadow: Phaser.GameObjects.Ellipse;
  private readonly nameplate: Phaser.GameObjects.Text;
  private motionBlend = 0;
  private sprintBlend = 0;
  private remote = false;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    createPlayerTexture(scene);
    super(scene, x, y, PLAYER_TEXTURE);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setCollideWorldBounds(true);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setCircle(GAME.playerCollisionRadiusPixels, 3, 11);
    this.shadow = scene.add.ellipse(x, y + 17, 34, 11, 0x102326, 0.28);
    this.facingMarker = scene.add.triangle(x, y, 0, 0, 11, 4.5, 0, 9, 0xfff0ad)
      .setStrokeStyle(2, 0x173139, 0.95);
    this.nameplate = scene.add.text(x, y - 31, 'YOU', {
      color: '#fff8dd', backgroundColor: '#203735', fontFamily: 'monospace',
      fontSize: '9px', fontStyle: 'bold', padding: { x: 4, y: 2 },
    }).setOrigin(0.5);
    this.setData('animationState', this.currentAnimation);
    this.updatePresentationDepth();
  }

  move(velocity: Vector2, sprinting: boolean, reducedMotion = false): void {
    // Position is driven by shared fixed-step prediction/interpolation, not Arcade integration.
    this.setVelocity(0, 0);
    this.facing = facingFromVelocity(velocity, this.facing);
    this.currentAnimation = animationState(velocity, sprinting, this.facing);
    this.setData('animationState', this.currentAnimation);

    const moving = velocity.x !== 0 || velocity.y !== 0;
    const frameBlend = Math.min(1, (this.scene.game.loop.delta || 16.67) / 75);
    this.motionBlend = Phaser.Math.Linear(this.motionBlend, moving ? 1 : 0, frameBlend);
    this.sprintBlend = Phaser.Math.Linear(this.sprintBlend, sprinting && moving ? 1 : 0, frameBlend);
    const cadence = sprinting ? 0.025 : 0.016;
    const bob = reducedMotion ? 0 : Math.sin(this.scene.time.now * cadence) * (1.4 * this.motionBlend + this.sprintBlend);
    const stride = reducedMotion ? 0 : Math.cos(this.scene.time.now * cadence) * (0.025 * this.motionBlend + 0.025 * this.sprintBlend);
    this.setScale(
      reducedMotion ? 1 : 1 + stride + this.sprintBlend * 0.05,
      reducedMotion ? 1 : 1 - stride - this.sprintBlend * 0.025,
    );
    this.setRotation(reducedMotion ? 0 : Phaser.Math.Linear(this.rotation, moving ? Phaser.Math.Clamp(velocity.x / 8_000, -0.055, 0.055) : 0, frameBlend));
    this.setTint(this.remote
      ? sprinting ? 0xbcecf0 : 0xd7e8e2
      : !moving ? 0xffffff : sprinting ? 0xffd77a : 0xf5f0dc);
    const direction = facingVector(this.facing);
    this.facingMarker.setPosition(this.x + direction.x * 19, this.y + direction.y * 19 + bob);
    this.facingMarker.setRotation(Math.atan2(direction.y, direction.x));
    this.shadow.setPosition(this.x, this.y + 18).setScale(1 + this.sprintBlend * 0.16, 1 - this.motionBlend * 0.08);
    this.nameplate.setPosition(this.x, this.y - 32 + bob * 0.35);
    this.updatePresentationDepth();
  }

  setRemote(label = 'RIVAL'): this {
    this.remote = true;
    this.setAlpha(0.9).setTint(0xd7e8e2);
    this.facingMarker.setFillStyle(0x9dd9df, 1);
    this.nameplate.setText(label.toUpperCase().slice(0, 12)).setColor('#d8f1ef');
    return this;
  }

  get animationState(): PlayerAnimationState {
    return this.currentAnimation;
  }

  override destroy(fromScene?: boolean): void {
    this.facingMarker.destroy(fromScene);
    this.shadow.destroy(fromScene);
    this.nameplate.destroy(fromScene);
    super.destroy(fromScene);
  }

  private updatePresentationDepth(): void {
    const depth = 1_000 + this.y;
    this.shadow.setDepth(depth - 2);
    this.setDepth(depth);
    this.facingMarker.setDepth(depth + 1);
    this.nameplate.setDepth(depth + 2);
  }
}

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

  constructor(scene: Phaser.Scene, x: number, y: number) {
    createPlayerTexture(scene);
    super(scene, x, y, PLAYER_TEXTURE);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(20).setCollideWorldBounds(true);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setCircle(GAME.playerCollisionRadiusPixels, 3, 11);
    this.facingMarker = scene.add.triangle(x, y, 0, 0, 9, 4, 0, 8, 0x173139).setDepth(21);
    this.setData('animationState', this.currentAnimation);
  }

  move(velocity: Vector2, sprinting: boolean): void {
    this.setVelocity(velocity.x, velocity.y);
    this.facing = facingFromVelocity(velocity, this.facing);
    this.currentAnimation = animationState(velocity, sprinting, this.facing);
    this.setData('animationState', this.currentAnimation);

    const moving = velocity.x !== 0 || velocity.y !== 0;
    this.setTint(!moving ? 0xffffff : sprinting ? 0xffd77a : 0xf5f0dc);
    const direction = facingVector(this.facing);
    this.facingMarker.setPosition(this.x + direction.x * 13, this.y + direction.y * 13);
    this.facingMarker.setRotation(Math.atan2(direction.y, direction.x));
  }

  get animationState(): PlayerAnimationState {
    return this.currentAnimation;
  }

  override destroy(fromScene?: boolean): void {
    this.facingMarker.destroy(fromScene);
    super.destroy(fromScene);
  }
}

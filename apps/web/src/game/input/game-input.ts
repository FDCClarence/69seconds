import Phaser from 'phaser';
import { movementVelocity, type MovementInput, type Vector2 } from '@69-seconds/shared';
import type { DebugAction } from '../types.js';

interface GameplayKeys {
  up: Phaser.Input.Keyboard.Key;
  down: Phaser.Input.Keyboard.Key;
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
  sprint: Phaser.Input.Keyboard.Key;
  interact: Phaser.Input.Keyboard.Key;
  shove: Phaser.Input.Keyboard.Key;
  debugReset: Phaser.Input.Keyboard.Key;
}

export interface InputFrame {
  movement: MovementInput;
  velocity: Vector2;
  sprinting: boolean;
}

export class GameInput {
  private readonly keyboard: Phaser.Input.Keyboard.KeyboardPlugin;
  private readonly keys: GameplayKeys;

  constructor(scene: Phaser.Scene) {
    const keyboard = scene.input.keyboard;
    if (!keyboard) throw new Error('The grocery scene requires keyboard input.');
    this.keyboard = keyboard;
    this.keys = keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      sprint: Phaser.Input.Keyboard.KeyCodes.SHIFT,
      interact: Phaser.Input.Keyboard.KeyCodes.SPACE,
      shove: Phaser.Input.Keyboard.KeyCodes.CTRL,
      debugReset: Phaser.Input.Keyboard.KeyCodes.R,
    }, true, false) as GameplayKeys;
  }

  read(): InputFrame {
    const movement: MovementInput = {
      up: this.keys.up.isDown,
      down: this.keys.down.isDown,
      left: this.keys.left.isDown,
      right: this.keys.right.isDown,
    };
    const sprinting = this.keys.sprint.isDown;
    return { movement, velocity: movementVelocity(movement, sprinting), sprinting };
  }

  readAction(): DebugAction | 'INTERACT' | null {
    if (Phaser.Input.Keyboard.JustDown(this.keys.interact)) return 'INTERACT';
    if (Phaser.Input.Keyboard.JustDown(this.keys.shove)) return 'SHOVE';
    return null;
  }

  readDebugReset(): boolean {
    return Phaser.Input.Keyboard.JustDown(this.keys.debugReset);
  }

  reset(): void {
    this.keyboard.resetKeys();
  }
}

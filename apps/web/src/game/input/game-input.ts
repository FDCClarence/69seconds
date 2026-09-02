import Phaser from 'phaser';
import type { MovementInput } from '@69-seconds/shared';
import type { GameAction } from '../types.js';

interface GameplayKeys {
  up: Phaser.Input.Keyboard.Key;
  down: Phaser.Input.Keyboard.Key;
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
  sprint: Phaser.Input.Keyboard.Key;
  interact: Phaser.Input.Keyboard.Key;
  shove: Phaser.Input.Keyboard.Key;
}

/**
 * Raw key state only. Velocity is deliberately not derived here: whether a held
 * Shift counts as sprinting depends on the stamina bar, which the scene tracks
 * and the server decides, so a velocity computed from the key alone would lie.
 */
export interface InputFrame {
  movement: MovementInput;
  /** Raw intent from the Shift key; effective sprinting is resolved elsewhere. */
  sprintHeld: boolean;
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
    }, true, false) as GameplayKeys;
  }

  read(): InputFrame {
    const movement: MovementInput = {
      up: this.keys.up.isDown,
      down: this.keys.down.isDown,
      left: this.keys.left.isDown,
      right: this.keys.right.isDown,
    };
    return { movement, sprintHeld: this.keys.sprint.isDown };
  }

  readAction(): GameAction | null {
    if (Phaser.Input.Keyboard.JustDown(this.keys.interact)) return 'INTERACT';
    if (Phaser.Input.Keyboard.JustDown(this.keys.shove)) return 'SHOVE';
    return null;
  }

  reset(): void {
    this.keyboard.resetKeys();
  }
}

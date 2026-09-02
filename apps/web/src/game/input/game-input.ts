import Phaser from 'phaser';
import type { MovementInput } from '@69-seconds/shared';
import type { GameAction } from '../types.js';
import {
  DEFAULT_INPUT_BINDINGS,
  phaserKeyCode,
  type InputBindings,
} from './key-bindings.js';

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
  private keys: GameplayKeys;

  constructor(scene: Phaser.Scene, bindings: InputBindings = DEFAULT_INPUT_BINDINGS) {
    const keyboard = scene.input.keyboard;
    if (!keyboard) throw new Error('The grocery scene requires keyboard input.');
    this.keyboard = keyboard;
    this.keys = this.createKeys(bindings);
  }

  updateBindings(bindings: InputBindings): void {
    this.reset();
    for (const key of Object.values(this.keys)) this.keyboard.removeKey(key, true);
    this.keys = this.createKeys(bindings);
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

  private createKeys(bindings: InputBindings): GameplayKeys {
    return this.keyboard.addKeys(Object.fromEntries(
      Object.entries(bindings).map(([action, code]) => [action, phaserKeyCode(code)]),
    ), true, false) as GameplayKeys;
  }
}

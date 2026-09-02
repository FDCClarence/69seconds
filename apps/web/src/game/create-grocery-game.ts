import Phaser from 'phaser';
import { GroceryStoreScene } from './scenes/grocery-store-scene.js';
import type { GroceryGameFactory } from './types.js';

const CAPTURED_KEYS = [
  Phaser.Input.Keyboard.KeyCodes.W,
  Phaser.Input.Keyboard.KeyCodes.A,
  Phaser.Input.Keyboard.KeyCodes.S,
  Phaser.Input.Keyboard.KeyCodes.D,
  Phaser.Input.Keyboard.KeyCodes.SHIFT,
  Phaser.Input.Keyboard.KeyCodes.SPACE,
  Phaser.Input.Keyboard.KeyCodes.CTRL,
  Phaser.Input.Keyboard.KeyCodes.R,
];

export const createGroceryGame: GroceryGameFactory = (parent, callbacks) => new Phaser.Game({
  type: Phaser.AUTO,
  parent,
  backgroundColor: '#132126',
  banner: false,
  scene: new GroceryStoreScene(callbacks),
  physics: {
    default: 'arcade',
    arcade: { debug: false, gravity: { x: 0, y: 0 } },
  },
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: '100%',
    height: '100%',
  },
  input: {
    keyboard: { target: parent, capture: CAPTURED_KEYS },
    mouse: { target: parent },
    touch: { target: parent },
  },
  autoFocus: false,
  render: { antialias: true, roundPixels: false },
});

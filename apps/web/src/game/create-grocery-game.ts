import Phaser from 'phaser';
import { GroceryStoreScene } from './scenes/grocery-store-scene.js';
import type { GroceryGameFactory } from './types.js';
import { DEFAULT_INPUT_BINDINGS, capturedKeyCodes } from './input/key-bindings.js';

export const createGroceryGame: GroceryGameFactory = (parent, callbacks) => new Phaser.Game({
  type: Phaser.AUTO,
  parent,
  backgroundColor: '#132126',
  banner: false,
  // Audio is owned by game-audio.ts. Leaving Phaser audio enabled creates a
  // second AudioContext whose delayed visibility callback can race teardown
  // and try to suspend/resume an already closed context in SPA navigation.
  audio: { noAudio: true },
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
    keyboard: { target: parent, capture: capturedKeyCodes(callbacks.getBindings?.() ?? DEFAULT_INPUT_BINDINGS) },
    mouse: { target: parent },
    touch: { target: parent },
  },
  autoFocus: false,
  render: { antialias: true, roundPixels: false },
});

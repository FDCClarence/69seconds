import { describe, expect, it, vi } from 'vitest';
import { mountGroceryGame } from './game-lifecycle.js';

describe('Phaser lifecycle bridge', () => {
  it('destroys exactly one mounted game and removes its canvas', () => {
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    const destroy = vi.fn();
    const factory = vi.fn((target: HTMLElement) => {
      target.append(canvas);
      return { destroy };
    });

    const cleanup = mountGroceryGame(parent, factory, {});
    expect(factory).toHaveBeenCalledOnce();
    expect(parent.querySelector('canvas')).toBe(canvas);

    cleanup();
    cleanup();
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(true);
    expect(parent.childElementCount).toBe(0);
  });
});

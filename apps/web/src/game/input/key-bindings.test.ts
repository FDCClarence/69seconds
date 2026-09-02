import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_BINDINGS, bindingLabel, capturedKeyCodes, rebindAction } from './key-bindings.js';

describe('central gameplay bindings', () => {
  it('swaps conflicts instead of leaving an action unreachable', () => {
    const rebound = rebindAction(DEFAULT_INPUT_BINDINGS, 'interact', 'KeyW');
    expect(rebound.interact).toBe('KeyW');
    expect(rebound.up).toBe('Space');
    expect(new Set(Object.values(rebound)).size).toBe(Object.values(rebound).length);

    const modifierSwap = rebindAction(DEFAULT_INPUT_BINDINGS, 'shove', 'ShiftRight');
    expect(modifierSwap.shove).toBe('ShiftRight');
    expect(modifierSwap.sprint).toBe('ControlLeft');
  });

  it('exposes readable labels and unique Phaser capture codes', () => {
    expect(bindingLabel('ControlLeft')).toBe('Ctrl');
    expect(bindingLabel('KeyQ')).toBe('Q');
    expect(new Set(capturedKeyCodes(DEFAULT_INPUT_BINDINGS)).size).toBe(7);
  });
});

import { describe, expect, it } from 'vitest';
import { RemoteInterpolationBuffer } from './interpolation.js';

describe('remote player interpolation', () => {
  it('interpolates buffered snapshots and ignores stale samples', () => {
    const buffer = new RemoteInterpolationBuffer();
    buffer.push(1_000, { x: 10, y: 20 });
    buffer.push(1_100, { x: 30, y: 40 });
    buffer.push(1_050, { x: 999, y: 999 });
    expect(buffer.sample(1_050)).toEqual({ x: 20, y: 30 });
    expect(buffer.sample(1_200)).toEqual({ x: 30, y: 40 });
  });
});

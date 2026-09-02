import { describe, expect, it } from 'vitest';
import {
  GENERATED_GROCERY_STORE_MAP,
  STORE_COLLISION_LAYER,
  STORE_OBJECT_LAYER,
  STORE_VISUAL_LAYERS,
  unreachableStoreRoutes,
} from './grocery-store-placeholder-map.js';

describe('generated grocery-store placeholder map', () => {
  it('keeps visual, collision, and object layers separate', () => {
    expect(STORE_VISUAL_LAYERS.shelves).toHaveLength(12);
    expect(STORE_COLLISION_LAYER).toHaveLength(12);
    expect(STORE_OBJECT_LAYER.carts).toHaveLength(4);
    expect(STORE_OBJECT_LAYER.lootSpawnPoints).toHaveLength(12);
  });

  it('has a collision-safe route from the central spawn to each pickup and cart', () => {
    expect(unreachableStoreRoutes(GENERATED_GROCERY_STORE_MAP)).toEqual([]);
  });
});

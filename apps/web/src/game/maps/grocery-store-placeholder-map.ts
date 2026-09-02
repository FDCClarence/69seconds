import {
  GAME,
  GROCERY_STORE_COLLISION,
  type CartId,
  type LootSpawnPoint,
} from '@69-seconds/shared';

/**
 * Generated placeholder map, deliberately kept as declarative layer data until
 * a hand-authored Tiled JSON export and tileset are available. Visual artwork,
 * physics collision, and interaction objects are separate below just as they
 * will be in the Tiled version. Do not use this client map as server authority.
 */
export interface StoreRectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StoreCart extends StoreRectangle {
  id: CartId;
  slot: number;
  label: string;
}

export interface StoreVisualShelf extends StoreRectangle {
  tint: number;
}

const mapWidth = GAME.mapWidthPixels;
const mapHeight = GAME.mapHeightPixels;

const shelfLayout = [
  [300, 260], [600, 260], [1_200, 260], [1_500, 260],
  [300, 480], [600, 480], [1_200, 480], [1_500, 480],
  [300, 700], [600, 700], [1_200, 700], [1_500, 700],
] as const;

/** The rendered shelf layer; it is never passed to Arcade Physics. */
export const STORE_VISUAL_LAYERS = {
  floor: { gridSize: 64, color: 0xd9ddcf, gridColor: 0xbfc7b8 },
  shelves: shelfLayout.map(([x, y], index): StoreVisualShelf => ({
    id: `shelf-visual-${index + 1}`,
    x,
    y,
    width: 260,
    height: 72,
    tint: index % 2 === 0 ? 0x36544d : 0x415f57,
  })),
} as const;

/** The invisible collision-object layer; its rectangles are independent bodies. */
export const STORE_COLLISION_LAYER: readonly StoreRectangle[] = GROCERY_STORE_COLLISION;

export const STORE_OBJECT_LAYER = {
  playerSpawn: { id: 'spawn-central', x: 900, y: 600 },
  carts: [
    { id: 'cart-0', slot: 0, label: 'Cart 1', x: 250, y: 1_060, width: 128, height: 72 },
    { id: 'cart-1', slot: 1, label: 'Cart 2', x: 650, y: 1_060, width: 128, height: 72 },
    { id: 'cart-2', slot: 2, label: 'Cart 3', x: 1_150, y: 1_060, width: 128, height: 72 },
    { id: 'cart-3', slot: 3, label: 'Cart 4', x: 1_550, y: 1_060, width: 128, height: 72 },
  ] as const satisfies readonly StoreCart[],
  lootSpawnPoints: [
    { id: 'loot-apples', catalogId: 'apples', x: 150, y: 175 },
    { id: 'loot-bread', catalogId: 'bread', x: 510, y: 175 },
    { id: 'loot-milk', catalogId: 'milk', x: 1_290, y: 175 },
    { id: 'loot-beans', catalogId: 'beans', x: 1_650, y: 175 },
    { id: 'loot-pasta', catalogId: 'pasta', x: 150, y: 390 },
    { id: 'loot-tea', catalogId: 'tea', x: 510, y: 390 },
    { id: 'loot-soap', catalogId: 'soap', x: 1_290, y: 390 },
    { id: 'loot-rice', catalogId: 'rice', x: 1_650, y: 390 },
    { id: 'loot-eggs', catalogId: 'eggs', x: 150, y: 880 },
    { id: 'loot-juice', catalogId: 'juice', x: 510, y: 880 },
    { id: 'loot-coffee', catalogId: 'coffee', x: 1_290, y: 880 },
    { id: 'loot-tomatoes', catalogId: 'tomatoes', x: 1_650, y: 880 },
  ] as const satisfies readonly LootSpawnPoint[],
} as const;

export const GENERATED_GROCERY_STORE_MAP = {
  source: 'generated-placeholder-v1',
  width: mapWidth,
  height: mapHeight,
  visualLayers: STORE_VISUAL_LAYERS,
  collisionLayer: STORE_COLLISION_LAYER,
  objectLayer: STORE_OBJECT_LAYER,
} as const;

interface GridPoint { x: number; y: number; }

function isWalkable(point: GridPoint, collisionLayer: readonly StoreRectangle[], width: number, height: number, clearance: number): boolean {
  if (point.x < clearance || point.x > width - clearance || point.y < clearance || point.y > height - clearance) return false;
  return !collisionLayer.some((rectangle) => (
    point.x >= rectangle.x - rectangle.width / 2 - clearance
      && point.x <= rectangle.x + rectangle.width / 2 + clearance
      && point.y >= rectangle.y - rectangle.height / 2 - clearance
      && point.y <= rectangle.y + rectangle.height / 2 + clearance
  ));
}

function gridKey(column: number, row: number): string {
  return `${column}:${row}`;
}

function nearestWalkableCell(target: GridPoint, walkable: ReadonlySet<string>, step: number): string | null {
  const column = Math.round(target.x / step);
  const row = Math.round(target.y / step);
  for (let radius = 0; radius < 8; radius += 1) {
    for (let y = row - radius; y <= row + radius; y += 1) {
      for (let x = column - radius; x <= column + radius; x += 1) {
        const key = gridKey(x, y);
        if (walkable.has(key)) return key;
      }
    }
  }
  return null;
}

/**
 * A small grid verifier for generated layouts. It proves that the central spawn
 * has a collision-safe route to every loot spawn and cart interaction object.
 */
export function unreachableStoreRoutes(map = GENERATED_GROCERY_STORE_MAP): string[] {
  const step = 32;
  const clearance = 22;
  const columns = Math.floor(map.width / step);
  const rows = Math.floor(map.height / step);
  const walkable = new Set<string>();
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const point = { x: column * step, y: row * step };
      if (isWalkable(point, map.collisionLayer, map.width, map.height, clearance)) walkable.add(gridKey(column, row));
    }
  }

  const start = nearestWalkableCell(map.objectLayer.playerSpawn, walkable, step);
  if (!start) return ['spawn-central'];
  const visited = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const [column, row] = current.split(':').map(Number) as [number, number];
    const neighbours: readonly [number, number][] = [[column - 1, row], [column + 1, row], [column, row - 1], [column, row + 1]];
    for (const [nextColumn, nextRow] of neighbours) {
      const next = gridKey(nextColumn, nextRow);
      if (walkable.has(next) && !visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const targets = [
    ...map.objectLayer.lootSpawnPoints.map((item) => ({ id: item.id, x: item.x, y: item.y })),
    ...map.objectLayer.carts.map((cart) => ({ id: cart.id, x: cart.x, y: cart.y })),
  ];
  return targets.flatMap((target) => {
    const cell = nearestWalkableCell(target, walkable, step);
    return cell && visited.has(cell) ? [] : [target.id];
  });
}

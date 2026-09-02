export type DebugAction = 'INTERACT' | 'SHOVE';

export interface GroceryGameCallbacks {
  onAction?: (action: DebugAction) => void;
  onReady?: () => void;
}

export interface DestroyableGame {
  destroy(removeCanvas: boolean): void;
}

export type GroceryGameFactory = (
  parent: HTMLElement,
  callbacks: GroceryGameCallbacks,
) => DestroyableGame;

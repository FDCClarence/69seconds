import type { DestroyableGame, GroceryGameCallbacks, GroceryGameFactory } from '../types.js';

export function mountGroceryGame(
  parent: HTMLElement,
  factory: GroceryGameFactory,
  callbacks: GroceryGameCallbacks,
): () => void {
  let game: DestroyableGame | null = factory(parent, callbacks);
  return () => {
    if (!game) return;
    game.destroy(true);
    game = null;
    parent.replaceChildren();
  };
}

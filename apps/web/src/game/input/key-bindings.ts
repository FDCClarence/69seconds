export type BindableAction = 'up' | 'down' | 'left' | 'right' | 'sprint' | 'interact' | 'shove' | 'drop';
export type InputBindings = Readonly<Record<BindableAction, string>>;

export const DEFAULT_INPUT_BINDINGS: InputBindings = Object.freeze({
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  interact: 'Space',
  shove: 'ControlLeft',
  drop: 'KeyQ',
});

export const BINDABLE_ACTIONS: readonly BindableAction[] = [
  'up', 'down', 'left', 'right', 'sprint', 'interact', 'shove', 'drop',
];

const PHASER_CODES: Readonly<Record<string, number>> = {
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Space: 32,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  ...Object.fromEntries(Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode(65 + index);
    return [`Key${letter}`, letter.charCodeAt(0)];
  })),
};

const STORAGE_KEY = '69-seconds.input-bindings.v1';

export function isBindableCode(code: string): boolean {
  return PHASER_CODES[code] !== undefined;
}

export function phaserKeyCode(code: string): number {
  return PHASER_CODES[code] ?? 32;
}

export function bindingLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  const labels: Readonly<Record<string, string>> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift',
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
  };
  return labels[code] ?? code;
}

/** Swaps a conflicting assignment so every action retains exactly one key. */
export function rebindAction(
  bindings: InputBindings,
  action: BindableAction,
  code: string,
): InputBindings {
  if (!isBindableCode(code) || bindings[action] === code) return bindings;
  const previousCode = bindings[action];
  const conflict = BINDABLE_ACTIONS.find((candidate) => (
    phaserKeyCode(bindings[candidate]) === phaserKeyCode(code)
  ));
  return {
    ...bindings,
    ...(conflict ? { [conflict]: previousCode } : {}),
    [action]: code,
  };
}

export function capturedKeyCodes(bindings: InputBindings): number[] {
  return [...new Set(Object.values(bindings).map(phaserKeyCode))];
}

export function loadInputBindings(): InputBindings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<InputBindings>;
    const candidate = Object.fromEntries(BINDABLE_ACTIONS.map((action) => [
      action,
      isBindableCode(parsed[action] ?? '') ? parsed[action] : DEFAULT_INPUT_BINDINGS[action],
    ])) as Record<BindableAction, string>;
    return capturedKeyCodes(candidate).length === BINDABLE_ACTIONS.length
      ? candidate
      : DEFAULT_INPUT_BINDINGS;
  } catch {
    return DEFAULT_INPUT_BINDINGS;
  }
}

export function saveInputBindings(bindings: InputBindings): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
}

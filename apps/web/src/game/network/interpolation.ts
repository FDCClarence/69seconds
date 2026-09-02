import type { Vector2 } from '@69-seconds/shared';

interface BufferedPosition {
  serverTimeMs: number;
  position: Vector2;
}

export class RemoteInterpolationBuffer {
  private readonly samples: BufferedPosition[] = [];

  push(serverTimeMs: number, position: Vector2): void {
    const latest = this.samples.at(-1);
    if (latest && serverTimeMs <= latest.serverTimeMs) return;
    this.samples.push({ serverTimeMs, position: { ...position } });
    if (this.samples.length > 20) this.samples.shift();
  }

  sample(serverTimeMs: number): Vector2 | null {
    if (this.samples.length === 0) return null;
    const first = this.samples[0]!;
    if (serverTimeMs <= first.serverTimeMs) return { ...first.position };
    for (let index = 1; index < this.samples.length; index += 1) {
      const right = this.samples[index]!;
      if (right.serverTimeMs < serverTimeMs) continue;
      const left = this.samples[index - 1]!;
      const span = right.serverTimeMs - left.serverTimeMs;
      const t = span <= 0 ? 1 : (serverTimeMs - left.serverTimeMs) / span;
      return {
        x: left.position.x + (right.position.x - left.position.x) * t,
        y: left.position.y + (right.position.y - left.position.y) * t,
      };
    }
    return { ...this.samples.at(-1)!.position };
  }
}

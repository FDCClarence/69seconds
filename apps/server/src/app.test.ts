import { healthResponseSchema, type ClientInput } from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('server workspace shared-contract consumption', () => {
  it('constructs the app and consumes the shared health contract', () => {
    const app = createApp('http://localhost:5173');
    const response = healthResponseSchema.parse({ status: 'ok', service: '69-seconds-server' });
    expect(typeof app).toBe('function');
    expect(response.status).toBe('ok');
  });

  it('can type a future simulation input with the shared contract', () => {
    const input: ClientInput = {
      sequence: 1,
      clientTimeMs: 100,
      movement: { up: true, down: false, left: false, right: false },
      sprint: false,
    };
    expect(input.movement.up).toBe(true);
  });
});

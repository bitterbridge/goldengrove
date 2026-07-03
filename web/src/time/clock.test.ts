import { describe, expect, it } from 'vitest';
import { SimClock } from './clock';

describe('SimClock', () => {
  it('accumulates wall time scaled by speed', () => {
    const c = new SimClock();
    c.speed = 3600;
    c.tick(0.5);
    expect(c.t).toBeCloseTo(1800);
  });

  it('does not advance while paused', () => {
    const c = new SimClock();
    c.paused = true;
    c.tick(10);
    expect(c.t).toBe(0);
  });
});

/** Maps wall time to simulation time. Sim time is f64 seconds from epoch. */
export class SimClock {
  t = 0;
  speed = 1;
  paused = false;

  tick(wallDtS: number): void {
    if (!this.paused) this.t += wallDtS * this.speed;
  }
}

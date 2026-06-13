export class SimulationClock {
  private current = 0;

  get now(): number {
    return this.current;
  }

  advanceTo(time: number): void {
    this.current = Math.max(this.current, time);
  }
}

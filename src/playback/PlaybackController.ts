import type { TimelineFrame } from '../types/timeline';

type PlaybackListener = (snapshot: PlaybackSnapshot) => void;

export type PlaybackSnapshot = {
  simulationTime: number;
  frameIndex: number;
  frameCount: number;
  frame?: TimelineFrame;
  playing: boolean;
};

type PlaybackClock = {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
};

export class PlaybackController {
  private frames: TimelineFrame[] = [];
  private listeners = new Set<PlaybackListener>();
  private speedFactor = 1;
  private currentSimulationTime = 0;
  private currentFrameIndex = -1;
  private playing = false;
  private anchorSimulationTime = 0;
  private anchorWallTime = 0;
  private frameHandle: number | undefined;
  private readonly clock: PlaybackClock;

  constructor(clock: Partial<PlaybackClock> = {}) {
    this.clock = {
      now: clock.now ?? (() => performance.now()),
      requestFrame: clock.requestFrame ?? ((callback) => requestAnimationFrame(callback)),
      cancelFrame: clock.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))
    };
  }

  loadTimeline(frames: TimelineFrame[]): void {
    this.pause();
    this.frames = [...frames];
    this.currentFrameIndex = this.frames.length ? 0 : -1;
    this.currentSimulationTime = this.frames[0]?.simulationTime ?? 0;
    this.anchorSimulationTime = this.currentSimulationTime;
    this.anchorWallTime = this.clock.now();
    this.emit();
  }

  onUpdate(listener: PlaybackListener): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  play(): void {
    if (this.playing || !this.frames.length) {
      return;
    }

    this.playing = true;
    this.anchorSimulationTime = this.currentSimulationTime;
    this.anchorWallTime = this.clock.now();
    this.scheduleFrame();
    this.emit();
  }

  pause(): void {
    if (!this.playing) {
      return;
    }

    this.updateTimeFromClock();
    this.playing = false;
    this.cancelScheduledFrame();
    this.emit();
  }

  stop(): void {
    this.pause();
    this.currentFrameIndex = -1;
    this.currentSimulationTime = 0;
    this.anchorSimulationTime = 0;
    this.anchorWallTime = this.clock.now();
    this.emit();
  }

  reset(): void {
    this.pause();
    this.currentFrameIndex = this.frames.length ? 0 : -1;
    this.currentSimulationTime = this.frames[0]?.simulationTime ?? 0;
    this.anchorSimulationTime = this.currentSimulationTime;
    this.anchorWallTime = this.clock.now();
    this.emit();
  }

  stepForward(): void {
    this.pause();

    if (!this.frames.length) {
      return;
    }

    this.setFrameIndex(Math.min(this.frames.length - 1, this.currentFrameIndex + 1));
  }

  stepBackward(): void {
    this.pause();

    if (!this.frames.length) {
      return;
    }

    this.setFrameIndex(Math.max(0, this.currentFrameIndex - 1));
  }

  seekToSimulationTime(time: number): void {
    this.pause();
    this.setSimulationTime(time);
  }

  setSpeedFactor(speed: number): void {
    if (this.playing) {
      this.updateTimeFromClock();
      this.anchorSimulationTime = this.currentSimulationTime;
      this.anchorWallTime = this.clock.now();
    }

    this.speedFactor = Math.max(0.0001, speed);
    this.emit();
  }

  getCurrentSimulationTime(): number {
    if (this.playing) {
      this.updateTimeFromClock();
    }

    return this.currentSimulationTime;
  }

  getCurrentFrameIndex(): number {
    return this.currentFrameIndex;
  }

  getFrameCount(): number {
    return this.frames.length;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private scheduleFrame(): void {
    this.cancelScheduledFrame();
    this.frameHandle = this.clock.requestFrame(() => this.tick());
  }

  private tick(): void {
    this.frameHandle = undefined;

    if (!this.playing) {
      return;
    }

    this.updateTimeFromClock();
    this.emit();

    if (this.currentFrameIndex >= this.frames.length - 1 &&
      this.currentSimulationTime >= (this.frames.at(-1)?.simulationTime ?? 0)) {
      this.playing = false;
      this.emit();
      return;
    }

    this.scheduleFrame();
  }

  private updateTimeFromClock(): void {
    if (!this.playing) {
      return;
    }

    const elapsed = (this.clock.now() - this.anchorWallTime) / 1000;
    this.setSimulationTime(this.anchorSimulationTime + elapsed * this.speedFactor, false);
  }

  private setFrameIndex(index: number): void {
    this.currentFrameIndex = index;
    this.currentSimulationTime = this.frames[index]?.simulationTime ?? 0;
    this.anchorSimulationTime = this.currentSimulationTime;
    this.anchorWallTime = this.clock.now();
    this.emit();
  }

  private setSimulationTime(time: number, emit = true): void {
    const first = this.frames[0]?.simulationTime ?? 0;
    const last = this.frames.at(-1)?.simulationTime ?? first;
    this.currentSimulationTime = clamp(time, first, last);
    this.currentFrameIndex = findFrameIndex(this.frames, this.currentSimulationTime);

    if (emit) {
      this.anchorSimulationTime = this.currentSimulationTime;
      this.anchorWallTime = this.clock.now();
      this.emit();
    }
  }

  private cancelScheduledFrame(): void {
    if (this.frameHandle !== undefined) {
      this.clock.cancelFrame(this.frameHandle);
      this.frameHandle = undefined;
    }
  }

  private emit(): void {
    const snapshot: PlaybackSnapshot = {
      simulationTime: this.currentSimulationTime,
      frameIndex: this.currentFrameIndex,
      frameCount: this.frames.length,
      frame: this.currentFrameIndex >= 0 ? this.frames[this.currentFrameIndex] : undefined,
      playing: this.playing
    };

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function findFrameIndex(frames: TimelineFrame[], time: number): number {
  if (!frames.length) {
    return -1;
  }

  let low = 0;
  let high = frames.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    if (frames[mid].simulationTime <= time) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

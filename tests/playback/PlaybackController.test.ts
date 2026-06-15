import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackController } from '../../src/playback/PlaybackController';
import type { TimelineFrame } from '../../src/types/timeline';

test('PlaybackController plays, pauses and resumes without time drift', () => {
  const clock = createClock();
  const controller = new PlaybackController(clock);

  controller.loadTimeline(frames([0, 10, 20]));
  controller.play();
  clock.tick(5000);

  assert.equal(controller.getCurrentSimulationTime(), 5);

  controller.pause();
  clock.tick(5000);

  assert.equal(controller.getCurrentSimulationTime(), 5);

  controller.play();
  clock.tick(5000);

  assert.equal(controller.getCurrentSimulationTime(), 10);
  assert.equal(controller.getCurrentFrameIndex(), 1);
});

test('PlaybackController applies speed changes, stepping and seeking deterministically', () => {
  const clock = createClock();
  const controller = new PlaybackController(clock);

  controller.loadTimeline(frames([0, 10, 20]));
  controller.setSpeedFactor(2);
  controller.play();
  clock.tick(5000);

  assert.equal(controller.getCurrentSimulationTime(), 10);
  assert.equal(controller.getCurrentFrameIndex(), 1);

  controller.stepForward();
  assert.equal(controller.getCurrentSimulationTime(), 20);
  assert.equal(controller.getCurrentFrameIndex(), 2);

  controller.stepBackward();
  assert.equal(controller.getCurrentSimulationTime(), 10);
  assert.equal(controller.getCurrentFrameIndex(), 1);

  controller.seekToSimulationTime(3);
  assert.equal(controller.getCurrentSimulationTime(), 3);
  assert.equal(controller.getCurrentFrameIndex(), 0);
});

test('PlaybackController starts playback at the first timeline frame', () => {
  const clock = createClock();
  const controller = new PlaybackController(clock);

  controller.loadTimeline(frames([8, 9]));

  assert.equal(controller.getCurrentSimulationTime(), 8);
  assert.equal(controller.getCurrentFrameIndex(), 0);
});

function createClock() {
  let now = 0;
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  return {
    now: () => now,
    requestFrame: (callback: FrameRequestCallback) => {
      const id = nextId;

      nextId += 1;
      callbacks.set(id, callback);

      return id;
    },
    cancelFrame: (handle: number) => {
      callbacks.delete(handle);
    },
    tick: (elapsed: number) => {
      now += elapsed;

      for (const [id, callback] of [...callbacks.entries()]) {
        callbacks.delete(id);
        callback(now);
      }
    }
  };
}

function frames(times: number[]): TimelineFrame[] {
  return times.map((simulationTime, index) => ({
    simulationTime,
    sequenceStart: index,
    sequenceEnd: index,
    events: [
      {
        id: `event-${index}`,
        simulationTime,
        sequence: index,
        type: 'TOKEN_ENTER_ELEMENT',
        processInstanceId: 'case-1'
      }
    ]
  }));
}

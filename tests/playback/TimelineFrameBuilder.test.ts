import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineFrameBuilder } from '../../src/playback/TimelineFrameBuilder';
import type { SimulationEvent } from '../../src/types/timeline';

test('TimelineFrameBuilder sorts events by time and sequence and groups equal simulation times', () => {
  const frames = new TimelineFrameBuilder().buildFrames([
    event('b', 2, 1),
    event('a2', 1, 2),
    event('a1', 1, 1),
    event('c', 3, 1)
  ]);

  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0].events.map((entry) => entry.id), ['a1', 'a2']);
  assert.equal(frames[0].sequenceStart, 1);
  assert.equal(frames[0].sequenceEnd, 2);
  assert.deepEqual(frames.map((frame) => frame.simulationTime), [1, 2, 3]);
});

test('TimelineFrameBuilder groups events inside epsilon and keeps stable order for equal keys', () => {
  const first = event('first', 1, 1);
  const second = event('second', 1, 1);
  const third = event('third', 1.04, 2);
  const fourth = event('fourth', 1.2, 3);
  const frames = new TimelineFrameBuilder().buildFrames([second, first, third, fourth], 0.05);

  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].events.map((entry) => entry.id), ['second', 'first', 'third']);
  assert.deepEqual(frames[1].events.map((entry) => entry.id), ['fourth']);
});

function event(id: string, simulationTime: number, sequence: number): SimulationEvent {
  return {
    id,
    simulationTime,
    sequence,
    type: 'TOKEN_ENTER_ELEMENT',
    processInstanceId: 'case-1',
    tokenId: id,
    elementId: 'task'
  };
}

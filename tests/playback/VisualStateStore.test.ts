import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineFrameBuilder } from '../../src/playback/TimelineFrameBuilder';
import { VisualStateStore } from '../../src/playback/VisualStateStore';
import type { SimulationEvent } from '../../src/types/timeline';

test('VisualStateStore reconstructs task, waiting and completed token states', () => {
  const frames = new TimelineFrameBuilder().buildFrames([
    event('created', 0, 0, 'TOKEN_CREATED', { tokenId: 't1', elementId: 'task' }),
    event('entered', 0, 1, 'TOKEN_ENTER_ELEMENT', { tokenId: 't1', elementId: 'task' }),
    event('started', 1, 2, 'TASK_STARTED', { tokenId: 't1', elementId: 'task' }),
    event('waiting', 2, 3, 'TOKEN_WAITING', { tokenId: 't2', elementId: 'catch' }),
    event('completed', 3, 4, 'TASK_COMPLETED', { tokenId: 't1', elementId: 'task' }),
    event('done', 4, 5, 'PROCESS_INSTANCE_COMPLETED', { tokenId: 't1', elementId: 'end' })
  ]);
  const store = new VisualStateStore(frames);
  const running = store.rebuildUntil(1.5);

  assert.deepEqual(running.activeElements, ['task']);
  assert.equal(running.tokens.find((token) => token.tokenId === 't1')?.status, 'active');

  const waiting = store.rebuildUntil(2.5);

  assert.equal(waiting.waitingTokens.length, 1);
  assert.equal(waiting.waitingTokens[0].elementId, 'catch');

  const completed = store.rebuildUntil(4);

  assert.ok(!completed.activeElements.includes('task'));
  assert.ok(completed.completedElements.includes('task'));
  assert.equal(completed.tokens.find((token) => token.tokenId === 't1')?.status, 'completed');
});

test('VisualStateStore starts parallel movements synchronously for same-time frames', () => {
  const frames = new TimelineFrameBuilder().buildFrames([
    event('move-b', 5, 10, 'TOKEN_MOVE_START', {
      tokenId: 'tb',
      sourceElementId: 'split',
      targetElementId: 'task-b',
      sequenceFlowId: 'flow-b',
      payload: { endTime: 6 }
    }),
    event('move-c', 5, 11, 'TOKEN_MOVE_START', {
      tokenId: 'tc',
      sourceElementId: 'split',
      targetElementId: 'task-c',
      sequenceFlowId: 'flow-c',
      payload: { endTime: 6 }
    }),
    event('end-b', 6, 12, 'TOKEN_MOVE_END', {
      tokenId: 'tb',
      targetElementId: 'task-b',
      sequenceFlowId: 'flow-b',
      payload: { terminateOnEnd: true }
    }),
    event('end-c', 6, 13, 'TOKEN_MOVE_END', {
      tokenId: 'tc',
      targetElementId: 'task-c',
      sequenceFlowId: 'flow-c',
      payload: { terminateOnEnd: true }
    })
  ]);
  const store = new VisualStateStore(frames);
  const state = store.rebuildUntil(5.5);
  const movements = state.tokens
    .filter((token) => token.status === 'moving')
    .map((token) => token.movement);

  assert.equal(movements.length, 2);
  assert.deepEqual(movements.map((movement) => movement?.startTime), [5, 5]);
  assert.deepEqual(movements.map((movement) => movement?.progress), [0.5, 0.5]);
  assert.equal(store.rebuildUntil(6).tokens.length, 0);
});

test('VisualStateStore terminates all visible tokens in a process instance', () => {
  const frames = new TimelineFrameBuilder().buildFrames([
    event('waiting', 1, 1, 'TOKEN_WAITING', { tokenId: 'wait-token', elementId: 'catch' }),
    event('active', 1, 2, 'TASK_STARTED', { tokenId: 'active-token', elementId: 'task' }),
    event('terminated', 2, 3, 'PROCESS_INSTANCE_TERMINATED', { tokenId: 'end-token', elementId: 'terminate' })
  ]);
  const store = new VisualStateStore(frames);

  assert.equal(store.rebuildUntil(1.5).tokens.length, 2);
  assert.equal(store.rebuildUntil(2).tokens.length, 0);
});

function event(
  id: string,
  simulationTime: number,
  sequence: number,
  type: SimulationEvent['type'],
  options: Partial<SimulationEvent>
): SimulationEvent {
  return {
    id,
    simulationTime,
    sequence,
    type,
    processInstanceId: 'case-1',
    ...options
  };
}

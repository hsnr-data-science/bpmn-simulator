import test from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../../src/simulation/EventQueue';

test('EventQueue pops events by time and insertion order', () => {
  const queue = new EventQueue();

  queue.schedule('TASK_COMPLETE', 5, { id: 'late' });
  queue.schedule('CASE_ARRIVAL', 1, { id: 'first' });
  queue.schedule('TOKEN_ENTER_ELEMENT', 1, { id: 'second' });

  assert.equal(queue.pop()?.type, 'CASE_ARRIVAL');
  assert.equal(queue.pop()?.type, 'TOKEN_ENTER_ELEMENT');
  assert.equal(queue.pop()?.type, 'TASK_COMPLETE');
  assert.equal(queue.pop(), undefined);
});

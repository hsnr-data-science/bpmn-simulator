import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLogImporter } from '../../src/playback/EventLogImporter';

test('EventLogImporter accepts a timeline array and fills missing sequence values stably', () => {
  const events = new EventLogImporter().parseJson({
    timeline: [
      {
        id: 'second',
        simulationTime: 2,
        type: 'TOKEN_ENTER_ELEMENT',
        processInstanceId: 'case-1',
        tokenId: 't2',
        elementId: 'task-b'
      },
      {
        id: 'first',
        simulationTime: 1,
        type: 'TOKEN_ENTER_ELEMENT',
        processInstanceId: 'case-1',
        tokenId: 't1',
        elementId: 'task-a'
      }
    ]
  });

  assert.deepEqual(events.map((event) => event.id), ['first', 'second']);
  assert.deepEqual(events.map((event) => event.sequence), [1, 0]);
});

test('EventLogImporter reports missing tokenIds as warning events', () => {
  const events = new EventLogImporter().parseJson([
    {
      id: 'task-start',
      simulationTime: 3,
      sequence: 1,
      type: 'TASK_STARTED',
      processInstanceId: 'case-1',
      elementId: 'task'
    }
  ]);

  assert.equal(events[0].type, 'TASK_STARTED');
  assert.equal(events[1].type, 'WARNING');
  assert.match(String(events[1].payload?.message), /no tokenId/);
});

test('EventLogImporter rejects invalid JSON shapes', () => {
  assert.throws(() => new EventLogImporter().parseJson({ notTimeline: [] }), /timeline array/);
  assert.throws(() => new EventLogImporter().parseJson([{ simulationTime: 1, type: 'NOPE' }]), /unsupported type/);
});

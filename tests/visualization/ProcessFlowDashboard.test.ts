import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProcessFlowModel, isInstantEventRecord } from '../../src/visualization/ProcessFlowDashboard';
import type { EventLogDataset } from '../../src/types/eventLog';

test('ProcessFlowDashboard builds resource/activity and transition matrices', () => {
  const model = buildProcessFlowModel({
    sourceName: 'test',
    sourceKind: 'upload',
    importedAt: new Date('2026-06-15T08:00:00'),
    warnings: [],
    records: [
      record('C1', 'A', 'Alice', '2026-06-15T08:00:00', 0),
      record('C1', 'B', 'Bob', '2026-06-15T08:10:00', 1),
      record('C1', 'C', 'Bob', '2026-06-15T08:20:00', 2),
      record('C2', 'A', 'Alice', '2026-06-15T08:00:00', 3),
      record('C2', 'C', 'Carol', '2026-06-15T08:05:00', 4)
    ]
  });

  assert.deepEqual(model.activities, ['A', 'C', 'B']);
  assert.deepEqual(model.resources, ['Alice', 'Carol', 'Bob']);
  assert.deepEqual(model.resourceActivityMatrix.values, [
    [2, 0, 0],
    [0, 1, 0],
    [0, 1, 1]
  ]);
  assert.deepEqual(model.activityTransitionMatrix.values, [
    [0, 1, 1],
    [0, 0, 0],
    [0, 1, 0]
  ]);
  assert.deepEqual(model.resourceTransitionMatrix.values, [
    [0, 1, 1],
    [0, 0, 0],
    [0, 0, 1]
  ]);
});

test('ProcessFlowDashboard hides instant events by default and can include them explicitly', () => {
  const instantWithoutEnd = record('C1', 'Start Event', 'Alice', '2026-06-15T07:59:00', 0, 'none');
  const instantSameEnd = record('C1', 'Boundary Event', 'Alice', '2026-06-15T08:05:00', 2, 'same');
  const dataset: EventLogDataset = {
    sourceName: 'test',
    sourceKind: 'upload',
    importedAt: new Date('2026-06-15T08:00:00'),
    warnings: [],
    records: [
      instantWithoutEnd,
      record('C1', 'A', 'Alice', '2026-06-15T08:00:00', 1),
      instantSameEnd,
      record('C1', 'B', 'Bob', '2026-06-15T08:10:00', 3)
    ]
  };

  assert.equal(isInstantEventRecord(instantWithoutEnd), true);
  assert.equal(isInstantEventRecord(instantSameEnd), true);

  const defaultModel = buildProcessFlowModel(dataset);
  const includedModel = buildProcessFlowModel(dataset, { includeInstantEvents: true });

  assert.deepEqual(defaultModel.activities, ['A', 'B']);
  assert.equal(defaultModel.records.length, 2);
  assert.equal(defaultModel.hiddenInstantEventCount, 2);
  assert.deepEqual(defaultModel.activityTransitionMatrix.values, [
    [0, 1],
    [0, 0]
  ]);

  assert.deepEqual(includedModel.activities, ['Start Event', 'A', 'Boundary Event', 'B']);
  assert.equal(includedModel.records.length, 4);
  assert.equal(includedModel.hiddenInstantEventCount, 0);
});

test('ProcessFlowDashboard orders matrix labels by first event-log occurrence', () => {
  const model = buildProcessFlowModel({
    sourceName: 'test',
    sourceKind: 'upload',
    importedAt: new Date('2026-06-15T08:00:00'),
    warnings: [],
    records: [
      record('C1', 'C', 'Carol', '2026-06-15T08:00:00', 0),
      record('C1', 'A', 'Alice', '2026-06-15T08:05:00', 1),
      record('C2', 'B', 'Bob', '2026-06-15T08:03:00', 2),
      record('C2', 'A', 'Alice', '2026-06-15T08:08:00', 3)
    ]
  });

  assert.deepEqual(model.activities, ['C', 'B', 'A']);
  assert.deepEqual(model.resources, ['Carol', 'Bob', 'Alice']);
  assert.deepEqual(model.resourceActivityMatrix.rows, ['Carol', 'Bob', 'Alice']);
  assert.deepEqual(model.resourceActivityMatrix.columns, ['C', 'B', 'A']);
});

function record(
  caseId: string,
  activityName: string,
  resource: string,
  startTime: string,
  sequence: number,
  endMode: 'duration' | 'same' | 'none' = 'duration'
): EventLogDataset['records'][number] {
  const start = new Date(startTime);
  const endTime = endMode === 'none'
    ? undefined
    : new Date(start.getTime() + (endMode === 'same' ? 0 : 60_000));

  return {
    caseId,
    activityId: activityName,
    activityName,
    resource,
    startTime: start,
    endTime,
    sequence
  };
}

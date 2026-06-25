import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardSeries, sampleStats } from '../../src/visualization/SimulationDashboard';
import type { SimulationResult } from '../../src/types/simulation';

test('SimulationDashboard builds process, task and resource time series', () => {
  const series = buildDashboardSeries(createResult());
  const process = series.find((entry) => entry.scope === 'process');
  const task = series.find((entry) => entry.scope === 'task');
  const resource = series.find((entry) => entry.scope === 'resource');

  assert.deepEqual(process?.serviceSamples, [5, 7]);
  assert.deepEqual(process?.waitSamples, [2, 4]);
  assert.deepEqual(task?.serviceSamples, [5, 7]);
  assert.deepEqual(task?.waitSamples, [2, 4]);
  assert.deepEqual(resource?.serviceSamples, [5, 7]);
  assert.deepEqual(resource?.waitSamples, [2, 4]);
});

test('SimulationDashboard calculates min, max, average and median', () => {
  assert.deepEqual(sampleStats([9, 1, 5, 3]), {
    min: 1,
    max: 9,
    avg: 4.5,
    median: 4
  });
});

function createResult(): SimulationResult {
  return {
    startedAt: new Date('2026-06-15T08:00:00'),
    completedAt: new Date('2026-06-15T09:00:00'),
    currentTime: 9,
    options: {
      numberOfRuns: 1,
      randomSeed: 1,
      animationSpeed: 1,
      collectTraces: true
    },
    processName: 'Order Process',
    cases: [
      caseTrace(1),
      caseTrace(2)
    ],
    completedCases: 2,
    failedCases: 0,
    cycleTimeAverage: 0,
    cycleTimeP50: 0,
    cycleTimeP90: 0,
    cycleTimeMax: 0,
    throughputPerTimeUnit: 0,
    elementMetrics: [
      {
        elementId: 'task',
        name: 'Task',
        type: 'bpmn:Task',
        visits: 2,
        completions: 2,
        errors: 0,
        retries: 0,
        waitTime: 6,
        waitTimeStddev: 1,
        waitTimeSamples: [2, 4],
        serviceTime: 12,
        serviceTimeSamples: [5, 7],
        unsupported: false
      }
    ],
    resourceMetrics: [
      {
        resourceId: 'worker',
        name: 'Worker',
        taskCount: 2,
        errors: 0,
        waitTime: 6,
        waitTimeSamples: [2, 4],
        serviceTime: 12,
        serviceTimeSamples: [5, 7],
        utilization: 0.5
      }
    ],
    flowMetrics: [],
    timeline: [],
    log: [
      logEntry(1, 'TOKEN_ENTER_ELEMENT', 8, undefined),
      logEntry(1, 'TASK_START', 8 + 2 / 60, undefined),
      logEntry(1, 'TASK_COMPLETE', 8 + 7 / 60, 5),
      logEntry(2, 'TOKEN_ENTER_ELEMENT', 8, undefined),
      logEntry(2, 'TASK_START', 8 + 4 / 60, undefined),
      logEntry(2, 'TASK_COMPLETE', 8 + 11 / 60, 7)
    ],
    warnings: [],
    unsupportedElementIds: [],
    activityUtilization: [],
    pathProbabilities: [],
    deadlockSuspicions: 0,
    unconsumedTokens: 0,
    exports: {
      json: '',
      csv: '',
      simulationResultsCsv: '',
      eventLogCsv: ''
    }
  };
}

function caseTrace(id: number): SimulationResult['cases'][number] {
  return {
    id,
    startTime: 8,
    endTime: 9,
    cycleTime: 1,
    status: 'completed',
    retries: 0,
    activeTokens: 0,
    path: [],
    outputs: {},
    errors: []
  };
}

function logEntry(
  caseId: number,
  eventType: NonNullable<SimulationResult['log'][number]['eventType']>,
  time: number,
  serviceTime: number | undefined
): SimulationResult['log'][number] {
  return {
    level: 'info',
    eventType,
    caseId,
    elementId: 'task',
    message: eventType,
    time,
    serviceTime
  };
}

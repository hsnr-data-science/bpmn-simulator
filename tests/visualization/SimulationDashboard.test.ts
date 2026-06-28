import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDashboardSeries,
  buildDashboardSeriesFromEventLog,
  eventLogProcessInstanceCount,
  sampleStats
} from '../../src/visualization/SimulationDashboard';
import type { SimulationResult } from '../../src/types/simulation';
import type { EventLogDataset } from '../../src/types/eventLog';

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

test('SimulationDashboard switches to samples excluding off-timetable hours', () => {
  const series = buildDashboardSeries(createResult(), 'excludingOffTimetable');
  const process = series.find((entry) => entry.scope === 'process');
  const task = series.find((entry) => entry.scope === 'task');
  const resource = series.find((entry) => entry.scope === 'resource');

  assert.deepEqual(process?.serviceSamples, [4, 6]);
  assert.deepEqual(process?.waitSamples, [1, 2]);
  assert.deepEqual(task?.serviceSamples, [4, 6]);
  assert.deepEqual(task?.waitSamples, [1, 2]);
  assert.deepEqual(resource?.serviceSamples, [4, 6]);
  assert.deepEqual(resource?.waitSamples, [1, 2]);
});

test('SimulationDashboard calculates min, max, average and median', () => {
  assert.deepEqual(sampleStats([9, 1, 5, 3]), {
    min: 1,
    max: 9,
    avg: 4.5,
    median: 4
  });
});

test('SimulationDashboard keeps correlated process scopes separate', () => {
  const result = createResult();

  result.processMetrics = [
    processMetric('customer', 'Customer Process'),
    processMetric('vendor', 'Vendor Process')
  ];
  result.cases = [
    caseTrace(1, 'customer'),
    caseTrace(2, 'vendor')
  ];
  result.log = [
    logEntry(1, 'TOKEN_ENTER_ELEMENT', 8),
    logEntry(1, 'TASK_START', 8 + 2 / 60, undefined, 2, 1),
    logEntry(1, 'TASK_COMPLETE', 8 + 7 / 60, 5, undefined, undefined, 4),
    logEntry(2, 'TOKEN_ENTER_ELEMENT', 8),
    logEntry(2, 'TASK_START', 8 + 4 / 60, undefined, 4, 2),
    logEntry(2, 'TASK_COMPLETE', 8 + 11 / 60, 7, undefined, undefined, 6)
  ];

  const processSeries = buildDashboardSeries(result).filter((entry) => entry.scope === 'process');

  assert.deepEqual(processSeries.map((entry) => entry.label), [
    'Process: Customer Process',
    'Process: Vendor Process'
  ]);
  assert.deepEqual(processSeries[0].serviceSamples, [5]);
  assert.deepEqual(processSeries[1].serviceSamples, [7]);
});

test('SimulationDashboard builds performance series from imported event logs', () => {
  const dataset: EventLogDataset = {
    sourceName: 'external.csv',
    sourceKind: 'upload',
    importedAt: new Date('2026-06-15T08:00:00'),
    warnings: [],
    records: [
      eventRecord('C1', 'A', 'Register', 'Alice', '2026-06-15T08:00:00', '2026-06-15T08:05:00', 0),
      eventRecord('C1', 'B', 'Approve', 'Bob', '2026-06-15T08:07:00', '2026-06-15T08:10:00', 1),
      eventRecord('C2', 'A', 'Register', 'Alice', '2026-06-15T09:00:00', '2026-06-15T09:04:00', 2)
    ]
  };
  const series = buildDashboardSeriesFromEventLog(dataset);
  const process = series.find((entry) => entry.scope === 'process');
  const register = series.find((entry) => entry.id === 'task:A');
  const bob = series.find((entry) => entry.id === 'resource:Bob');

  assert.equal(eventLogProcessInstanceCount(dataset), 2);
  assert.deepEqual(process?.serviceSamples, [8, 4]);
  assert.deepEqual(process?.waitSamples, [2, 0]);
  assert.deepEqual(register?.serviceSamples, [5, 4]);
  assert.deepEqual(bob?.waitSamples, [2]);
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
        waitTimeExcludingOffTimetable: 3,
        waitTimeStddevExcludingOffTimetable: 0.5,
        waitTimeSamplesExcludingOffTimetable: [1, 2],
        serviceTime: 12,
        serviceTimeSamples: [5, 7],
        serviceTimeExcludingOffTimetable: 10,
        serviceTimeSamplesExcludingOffTimetable: [4, 6],
        unsupported: false
      }
    ],
    processMetrics: [
      processMetric('process', 'Order Process')
    ],
    resourceMetrics: [
      {
        resourceId: 'worker',
        name: 'Worker',
        taskCount: 2,
        errors: 0,
        waitTime: 6,
        waitTimeSamples: [2, 4],
        waitTimeExcludingOffTimetable: 3,
        waitTimeSamplesExcludingOffTimetable: [1, 2],
        serviceTime: 12,
        serviceTimeSamples: [5, 7],
        serviceTimeExcludingOffTimetable: 10,
        serviceTimeSamplesExcludingOffTimetable: [4, 6],
        utilization: 0.5
      }
    ],
    flowMetrics: [],
    timeline: [],
    log: [
      logEntry(1, 'TOKEN_ENTER_ELEMENT', 8),
      logEntry(1, 'TASK_START', 8 + 2 / 60, undefined, 2, 1),
      logEntry(1, 'TASK_COMPLETE', 8 + 7 / 60, 5, undefined, undefined, 4),
      logEntry(2, 'TOKEN_ENTER_ELEMENT', 8),
      logEntry(2, 'TASK_START', 8 + 4 / 60, undefined, 4, 2),
      logEntry(2, 'TASK_COMPLETE', 8 + 11 / 60, 7, undefined, undefined, 6)
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

function caseTrace(id: number, processId = 'process'): SimulationResult['cases'][number] {
  return {
    id,
    processId,
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

function processMetric(processId: string, name: string): SimulationResult['processMetrics'][number] {
  return {
    processId,
    name,
    instanceCount: 0,
    completedInstances: 0,
    failedInstances: 0,
    serviceTimeSamples: [],
    serviceTimeSamplesExcludingOffTimetable: [],
    waitTimeSamples: [],
    waitTimeSamplesExcludingOffTimetable: []
  };
}

function logEntry(
  caseId: number,
  eventType: NonNullable<SimulationResult['log'][number]['eventType']>,
  time: number,
  serviceTime?: number,
  waitTime?: number,
  waitTimeExcludingOffTimetable?: number,
  serviceTimeExcludingOffTimetable?: number
): SimulationResult['log'][number] {
  return {
    level: 'info',
    eventType,
    caseId,
    elementId: 'task',
    message: eventType,
    time,
    serviceTime,
    waitTime,
    waitTimeExcludingOffTimetable,
    serviceTimeExcludingOffTimetable
  };
}

function eventRecord(
  caseId: string,
  activityId: string,
  activityName: string,
  resource: string,
  startTime: string,
  endTime: string,
  sequence: number
): EventLogDataset['records'][number] {
  return {
    caseId,
    activityId,
    activityName,
    resource,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    sequence
  };
}

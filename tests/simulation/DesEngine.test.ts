import test from 'node:test';
import assert from 'node:assert/strict';
import type { SimFlow, SimModel, SimNode } from '../../src/types/bpmn';
import { DesEngine } from '../../src/simulation/DesEngine';
import { eventLogDatasetFromSimulationResult } from '../../src/simulation/EventLogDataset';
import { createProgressResult } from '../../src/visualization/DesTokenAnimator';
import { buildDashboardSeries } from '../../src/visualization/SimulationDashboard';

test('DES draws fixed task duration and completes the process after that duration', () => {
  const result = new DesEngine(createLinearModel(), {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(result.completedCases, 1);
  assert.equal(result.cases[0].cycleTime, 5 / 60);
  assert.equal(result.elementMetrics.find((metric) => metric.elementId === 'task')?.serviceTime, 5);
});

test('DES delays activity starts before drawing the service duration', () => {
  const model = createLinearModel();
  const task = model.nodes.get('task');

  if (!task) {
    throw new Error('task missing');
  }

  task.params.delay = {
    type: 'fixed',
    mean: 10
  };

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const taskMetrics = result.elementMetrics.find((metric) => metric.elementId === 'task');
  const taskStart = result.log.find((entry) => entry.eventType === 'TASK_START');

  assert.equal(result.completedCases, 1);
  assert.equal(result.cases[0].cycleTime, 15 / 60);
  assert.equal(taskMetrics?.waitTime, 10);
  assert.equal(taskMetrics?.serviceTime, 5);
  assert.equal(taskStart?.time, 10 / 60);
});

test('DES uses resource calendars for task start and working-time completion', () => {
  const model = createLinearModel();
  const task = model.nodes.get('task');

  if (!task) {
    throw new Error('task missing');
  }

  task.params.resource = {
    resourceId: 'calendar_resource',
    capacity: 1,
    weekdays: [1, 2, 3, 4, 5],
    hourRanges: [{ start: 8, end: 10 }]
  };
  task.params.duration = {
    type: 'fixed',
    mean: 180
  };

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(result.completedCases, 1);
  assert.equal(result.cases[0].cycleTime, 33);
  const taskMetrics = result.elementMetrics.find((metric) => metric.elementId === 'task');
  const liveResult = createProgressResult(result, result.currentTime ?? 0, []);
  const liveResource = liveResult.resourceMetrics.find((metric) => metric.resourceId === 'calendar_resource');

  assert.equal(taskMetrics?.waitTime, 480);
  assert.equal(taskMetrics?.waitTimeExcludingOffTimetable, 0);
  assert.equal(taskMetrics?.serviceTime, 1500);
  assert.equal(taskMetrics?.serviceTimeExcludingOffTimetable, 180);
  assert.equal(result.log.find((entry) => entry.eventType === 'TASK_COMPLETE')?.serviceTime, 1500);
  assert.equal(
    result.log.find((entry) => entry.eventType === 'TASK_COMPLETE')
      ?.serviceTimeExcludingOffTimetable,
    180
  );
  assert.ok(Math.abs((liveResource?.utilization ?? 0) - 1) < 1e-9);
  assert.ok((liveResource?.utilization ?? 0) <= 1);
});

test('DES constrains start event arrivals to the configured arrival calendar', () => {
  const model = createLinearModel();
  const start = model.nodes.get('start');

  if (!start) {
    throw new Error('start missing');
  }

  start.params.arrival = {
    type: 'fixed',
    interval: 60,
    weekdays: [1],
    hourRanges: [{ start: 8, end: 10 }]
  };

  const result = new DesEngine(model, {
    numberOfRuns: 2,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.deepEqual(result.cases.map((caseTrace) => caseTrace.startTime), [8, 9]);
});

test('DES skips start events with arrival distribution none', () => {
  const model = createLinearModel();
  const start = model.nodes.get('start');

  if (!start) {
    throw new Error('start missing');
  }

  start.params.arrival = {
    type: 'none'
  };

  const result = new DesEngine(model, {
    numberOfRuns: 5,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(result.cases.length, 0);
  assert.equal(result.completedCases, 0);
});

test('DES uses start event numberOfCases before the global run count', () => {
  const model = createLinearModel();
  const start = model.nodes.get('start');

  if (!start) {
    throw new Error('start missing');
  }

  start.params.arrival = {
    type: 'fixed',
    interval: 60,
    numberOfCases: 2
  };

  const result = new DesEngine(model, {
    numberOfRuns: 5,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(result.cases.length, 2);
  assert.deepEqual(result.cases.map((caseTrace) => caseTrace.startTime), [8, 9]);
});

test('DES runs past the visual arrival estimate unless an explicit maxSimulationTime is set', () => {
  const model = createLinearModel();
  const start = model.nodes.get('start');
  const task = model.nodes.get('task');

  if (!start || !task) {
    throw new Error('model incomplete');
  }

  start.params.arrival = {
    type: 'fixed',
    interval: 1,
    numberOfCases: 3
  };
  task.params.duration = {
    type: 'fixed',
    mean: 120
  };

  const fullRun = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const cappedRun = new DesEngine(model, {
    numberOfRuns: 1,
    maxSimulationTime: 9,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(fullRun.cases.length, 3);
  assert.equal(fullRun.completedCases, 3);
  assert.ok((fullRun.currentTime ?? 0) > 10);
  assert.equal(cappedRun.completedCases, 0);
  assert.equal(cappedRun.deadlockSuspicions, 3);
  assert.match(cappedRun.warnings.join('\n'), /Zeithorizont/);
});

test('DES reports standard deviation for task waiting times', () => {
  const model = createLinearModel();
  const start = model.nodes.get('start');
  const task = model.nodes.get('task');

  if (!start || !task) {
    throw new Error('model incomplete');
  }

  start.params.arrival = {
    type: 'fixed',
    interval: 0
  };
  task.params.resource = {
    resourceId: 'single_worker',
    capacity: 1
  };

  const result = new DesEngine(model, {
    numberOfRuns: 2,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const taskMetrics = result.elementMetrics.find((metric) => metric.elementId === 'task');

  assert.ok(Math.abs((taskMetrics?.waitTime ?? 0) - 5) < 1e-9);
  assert.ok(Math.abs((taskMetrics?.waitTimeStddev ?? 0) - 2.5) < 1e-9);
});

test('Dashboard process wait samples sum actual task waiting per case', () => {
  const model = createLinearModel();
  const start = model.nodes.get('start');
  const task = model.nodes.get('task');

  if (!start || !task) {
    throw new Error('model incomplete');
  }

  start.params.arrival = {
    type: 'fixed',
    interval: 0,
    numberOfCases: 2
  };
  task.params.resource = {
    resourceId: 'single_worker',
    capacity: 1
  };

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const processSeries = buildDashboardSeries(result).find((series) => series.scope === 'process');

  assert.deepEqual(processSeries?.waitSamples, [0, 5]);
});

test('DES samples output objects for completed tasks', () => {
  const model = createLinearModel();
  const task = model.nodes.get('task');

  if (!task) {
    throw new Error('task missing');
  }

  task.kind = 'userTask';
  task.params.outputObject = {
    fields: [
      {
        key: 'count',
        type: 'int',
        generator: 'fixed',
        value: '5'
      },
      {
        key: 'status',
        type: 'string',
        generator: 'categorical',
        choices: [
          { value: 'ok', probability: 1 }
        ]
      }
    ]
  };

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.deepEqual(result.cases[0].outputs.task, {
    count: 5,
    status: 'ok'
  });
});

test('DES fails an activity error without scheduling retries', () => {
  const model = createLinearModel();
  const task = model.nodes.get('task');

  if (!task) {
    throw new Error('task missing');
  }

  task.kind = 'serviceTask';
  task.params.resource = {
    resourceId: 'error_worker',
    capacity: 1
  };
  task.params.error = {
    probability: 1,
    possibleErrors: [{ errorCode: 'test_error', probability: 1 }]
  };

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const taskMetrics = result.elementMetrics.find((metric) => metric.elementId === 'task');
  const resource = result.resourceMetrics.find((metric) => metric.resourceId === 'error_worker');

  assert.equal(result.failedCases, 1);
  assert.equal(taskMetrics?.visits, 1);
  assert.equal(taskMetrics?.retries, 0);
  assert.equal(taskMetrics?.serviceTimeSamples?.length, 1);
  assert.equal(resource?.taskCount, 1);
  assert.equal(resource?.serviceTimeSamples?.length, 1);
  assert.equal(result.cases[0].errors.includes('test_error'), true);
});

test('DES exports event log CSV and simulation result CSV with resource metrics', () => {
  const model = createLinearModel();
  const task = model.nodes.get('task');

  if (!task) {
    throw new Error('task missing');
  }

  task.kind = 'serviceTask';
  task.params.resource = {
    resourceId: 'worker',
    capacity: 1
  };
  task.params.outputObject = {
    fields: [
      {
        key: 'status',
        type: 'string',
        generator: 'fixed',
        value: 'done'
      }
    ]
  };

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    startDateTime: '2026-06-15T08:00',
    startTime: 8,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const resource = result.resourceMetrics.find((metric) => metric.resourceId === 'worker');

  assert.equal(resource?.taskCount, 1);
  assert.equal(resource?.errors, 0);
  assert.equal(resource?.serviceTime, 5);
  assert.ok(Math.abs((resource?.utilization ?? 0) - 1) < 1e-9);
  assert.match(result.exports.eventLogCsv, /CaseID;TaskID \/ EventID;TaskName \/ Event Name;Startzeit;Endzeit;Resource;Variables/);
  assert.match(result.exports.eventLogCsv, /1;task;Task;2026-06-15 08:00:00;2026-06-15 08:05:00;worker/);
  assert.match(result.exports.eventLogCsv, /status/);
  assert.match(result.exports.simulationResultsCsv, /Task;task;Task;1;0;5;5;5;5;0;0;0;0/);
  assert.match(result.exports.simulationResultsCsv, /Auslastung/);
  assert.match(result.exports.simulationResultsCsv, /Resource;worker;worker;1;0;5;5;5;5;0;0;0;0;1/);
});

test('DES records concrete resource instances for event-log visualizations', () => {
  const model = createLinearModel();
  const task = model.nodes.get('task');

  if (!task) {
    throw new Error('task missing');
  }

  task.params.resource = {
    resourceId: 'team',
    capacity: 2
  };

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const taskStart = result.log.find((entry) => entry.eventType === 'TASK_START');
  const dataset = eventLogDatasetFromSimulationResult(result);
  const record = dataset.records.find((entry) => entry.activityId === 'task');

  assert.equal(taskStart?.resourceId, 'team');
  assert.equal(taskStart?.resourceInstanceId, 'team #1');
  assert.equal(record?.resource, 'team');
  assert.equal(record?.resourceInstance, 'team #1');
});

test('DES can bind repeated role work to the same resource instance within a process instance', () => {
  const result = new DesEngine(createTwoTaskResourceModel(), {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const startsByCase = new Map<number, Map<string, string>>();

  for (const entry of result.log) {
    if (entry.eventType !== 'TASK_START' || entry.caseId === undefined || !entry.resourceInstanceId || !entry.elementId) {
      continue;
    }

    const caseStarts = startsByCase.get(entry.caseId) ?? new Map<string, string>();

    caseStarts.set(entry.elementId, entry.resourceInstanceId);
    startsByCase.set(entry.caseId, caseStarts);
  }

  assert.equal(result.completedCases, 2);

  for (const caseStarts of startsByCase.values()) {
    assert.equal(caseStarts.get('task-2'), caseStarts.get('task-1'));
  }
});

test('DES terminates open child processes when a parent process reaches a terminate end event', () => {
  const result = new DesEngine(createParentTerminationModel(), {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const parent = result.cases.find((caseTrace) => caseTrace.trigger === 'arrival');
  const child = result.cases.find((caseTrace) => caseTrace.trigger === 'subProcess');

  assert.ok(parent);
  assert.ok(child);
  assert.equal(parent.status, 'completed');
  assert.equal(child.parentCaseId, parent.id);
  assert.equal(child.status, 'completed');
  assert.equal(child.endTime, parent.endTime);
  assert.equal(result.log.some((entry) => entry.caseId === child.id && entry.eventType === 'TASK_COMPLETE'), false);
});

test('DES derives child process case IDs from the parent case ID', () => {
  const result = new DesEngine(createParentTerminationModel(), {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const parent = result.cases.find((caseTrace) => caseTrace.trigger === 'arrival');
  const child = result.cases.find((caseTrace) => caseTrace.trigger === 'subProcess');

  assert.ok(parent);
  assert.ok(child);
  assert.equal(child.id, parent.id * 1_000_000 + 1);
});

test('DES routes XOR conditions with variables from previous output objects', () => {
  const model = createConditionModel();

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(result.completedCases, 1);
  assert.deepEqual(result.cases[0].outputs.task, {
    status: 'ok'
  });
  assert.ok(result.cases[0].path.includes('flow_ok'));
  assert.ok(!result.cases[0].path.includes('flow_default'));
});

function createLinearModel(): SimModel {
  const nodes: SimNode[] = [
    node('start', 'Start', 'startEvent', ['flow_start_task']),
    {
      ...node('task', 'Task', 'task', ['flow_task_end'], ['flow_start_task']),
      params: {
        duration: {
          type: 'fixed',
          mean: 5
        }
      }
    },
    node('end', 'End', 'endEvent', [], ['flow_task_end'])
  ];
  const flows: SimFlow[] = [
    flow('flow_start_task', 'start', 'task'),
    flow('flow_task_end', 'task', 'end')
  ];

  return {
    id: 'process',
    name: 'Process',
    resources: new Map(),
    nodes: new Map(nodes.map((item) => [item.id, item])),
    flows: new Map(flows.map((item) => [item.id, item])),
    startNodeIds: ['start'],
    unsupportedElementIds: []
  };
}

function createTwoTaskResourceModel(): SimModel {
  const resource = {
    resourceId: 'delivery_boy',
    resourceName: 'Delivery Boy',
    capacity: 2,
    sameInstanceAsBefore: true
  };
  const nodes: SimNode[] = [
    {
      ...node('start', 'Start', 'startEvent', ['flow_start_task_1']),
      params: {
        arrival: {
          type: 'fixed',
          interval: 0,
          numberOfCases: 2
        }
      }
    },
    {
      ...node('task-1', 'Deliver Pizza', 'serviceTask', ['flow_task_1_task_2'], ['flow_start_task_1']),
      params: {
        duration: {
          type: 'fixed',
          mean: 10
        },
        resource
      }
    },
    {
      ...node('task-2', 'Take Payment', 'serviceTask', ['flow_task_2_end'], ['flow_task_1_task_2']),
      params: {
        duration: {
          type: 'fixed',
          mean: 1
        },
        resource
      }
    },
    node('end', 'End', 'endEvent', [], ['flow_task_2_end'])
  ];
  const flows: SimFlow[] = [
    flow('flow_start_task_1', 'start', 'task-1'),
    flow('flow_task_1_task_2', 'task-1', 'task-2'),
    flow('flow_task_2_end', 'task-2', 'end')
  ];

  return {
    id: 'resourceProcess',
    name: 'Resource Process',
    resources: new Map(),
    nodes: new Map(nodes.map((item) => [item.id, item])),
    flows: new Map(flows.map((item) => [item.id, item])),
    startNodeIds: ['start'],
    unsupportedElementIds: []
  };
}

function createParentTerminationModel(): SimModel {
  const nodes: SimNode[] = [
    node('start', 'Start', 'startEvent', ['flow_start_split']),
    node('split', 'Split', 'parallelGateway', ['flow_split_sub', 'flow_split_wait'], ['flow_start_split']),
    {
      ...node('sub', 'Long Child Work', 'subProcess', [], ['flow_split_sub']),
      subProcessStartIds: ['sub-start'],
      subProcessEndIds: ['sub-end']
    },
    {
      ...node('wait', 'Wait Before Terminate', 'task', ['flow_wait_terminate'], ['flow_split_wait']),
      params: {
        duration: {
          type: 'fixed',
          mean: 1
        }
      }
    },
    {
      ...node('terminate', 'Terminate', 'endEvent', [], ['flow_wait_terminate']),
      eventDefinitions: [{ type: 'terminate' }]
    },
    {
      ...node('sub-start', 'Sub Start', 'startEvent', ['flow_sub_start_task']),
      parentSubProcessId: 'sub'
    },
    {
      ...node('sub-task', 'Long Task', 'task', ['flow_sub_task_end'], ['flow_sub_start_task']),
      parentSubProcessId: 'sub',
      params: {
        duration: {
          type: 'fixed',
          mean: 120
        }
      }
    },
    {
      ...node('sub-end', 'Sub End', 'endEvent', [], ['flow_sub_task_end']),
      parentSubProcessId: 'sub'
    }
  ];
  const flows: SimFlow[] = [
    flow('flow_start_split', 'start', 'split'),
    flow('flow_split_sub', 'split', 'sub'),
    flow('flow_split_wait', 'split', 'wait'),
    flow('flow_wait_terminate', 'wait', 'terminate'),
    flow('flow_sub_start_task', 'sub-start', 'sub-task'),
    flow('flow_sub_task_end', 'sub-task', 'sub-end')
  ];

  return {
    id: 'terminationProcess',
    name: 'Termination Process',
    resources: new Map(),
    nodes: new Map(nodes.map((item) => [item.id, item])),
    flows: new Map(flows.map((item) => [item.id, item])),
    startNodeIds: ['start'],
    unsupportedElementIds: []
  };
}

function createConditionModel(): SimModel {
  const nodes: SimNode[] = [
    node('start', 'Start', 'startEvent', ['flow_start_task']),
    {
      ...node('task', 'Task', 'userTask', ['flow_task_xor'], ['flow_start_task']),
      params: {
        duration: {
          type: 'fixed',
          mean: 0
        },
        outputObject: {
          fields: [
            {
              key: 'status',
              type: 'string',
              generator: 'fixed',
              value: 'ok'
            }
          ]
        }
      }
    },
    {
      ...node('xor', 'Decision', 'exclusiveGateway', ['flow_ok', 'flow_default'], ['flow_task_xor']),
      defaultFlowId: 'flow_default'
    },
    node('okEnd', 'OkEnd', 'endEvent', [], ['flow_ok']),
    node('defaultEnd', 'DefaultEnd', 'endEvent', [], ['flow_default'])
  ];
  const flows: SimFlow[] = [
    flow('flow_start_task', 'start', 'task'),
    flow('flow_task_xor', 'task', 'xor'),
    {
      ...flow('flow_ok', 'xor', 'okEnd'),
      hasCondition: true,
      conditionExpression: 'status === "ok"'
    },
    flow('flow_default', 'xor', 'defaultEnd')
  ];

  return {
    id: 'conditionProcess',
    name: 'Condition Process',
    resources: new Map(),
    nodes: new Map(nodes.map((item) => [item.id, item])),
    flows: new Map(flows.map((item) => [item.id, item])),
    startNodeIds: ['start'],
    unsupportedElementIds: []
  };
}

function node(
  id: string,
  name: string,
  kind: SimNode['kind'],
  outgoing: string[],
  incoming: string[] = []
): SimNode {
  return {
    id,
    name,
    type: `bpmn:${name}`,
    kind,
    incoming,
    outgoing,
    params: {},
    supported: true
  };
}

function flow(id: string, sourceId: string, targetId: string): SimFlow {
  return {
    id,
    name: id,
    sourceId,
    targetId,
    hasCondition: false,
    params: {}
  };
}

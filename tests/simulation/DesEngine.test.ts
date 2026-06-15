import test from 'node:test';
import assert from 'node:assert/strict';
import type { SimFlow, SimModel, SimNode } from '../../src/types/bpmn';
import { DesEngine } from '../../src/simulation/DesEngine';

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

  assert.equal(taskMetrics?.waitTime, 480);
  assert.equal(taskMetrics?.serviceTime, 180);
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

test('DES does not count retry attempts as additional task visits', () => {
  const model = createLinearModel();
  const task = model.nodes.get('task');

  if (!task) {
    throw new Error('task missing');
  }

  task.kind = 'serviceTask';
  task.params.resource = {
    resourceId: 'retry_worker',
    capacity: 1
  };
  task.params.error = {
    probability: 1
  };
  task.params.failure = {
    retryCount: 1,
    retryDelay: {
      type: 'fixed',
      mean: 0
    }
  };

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const taskMetrics = result.elementMetrics.find((metric) => metric.elementId === 'task');
  const resource = result.resourceMetrics.find((metric) => metric.resourceId === 'retry_worker');

  assert.equal(result.failedCases, 1);
  assert.equal(taskMetrics?.visits, 1);
  assert.equal(taskMetrics?.retries, 1);
  assert.equal(taskMetrics?.serviceTimeSamples?.length, 2);
  assert.equal(resource?.taskCount, 1);
  assert.equal(resource?.serviceTimeSamples?.length, 2);
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
  assert.match(result.exports.eventLogCsv, /CaseID,TaskID \/ EventID,TaskName \/ Event Name,Startzeit,Endzeit,Resource,Variables/);
  assert.match(result.exports.eventLogCsv, /1,task,Task,2026-06-15 08:00:00,2026-06-15 08:05:00,worker/);
  assert.match(result.exports.eventLogCsv, /status/);
  assert.match(result.exports.simulationResultsCsv, /Task,task,Task,1,0,5,5,5,5,0,0,0,0/);
  assert.match(result.exports.simulationResultsCsv, /Auslastung/);
  assert.match(result.exports.simulationResultsCsv, /Resource,worker,worker,1,0,5,5,5,5,0,0,0,0,1/);
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

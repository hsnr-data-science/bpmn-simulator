import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBpmnGraph } from '../../src/bpmn/BpmnGraphBuilder';
import simulationModdle from '../../src/bpmn/simulationModdle.json';
import { DesEngine } from '../../src/simulation/DesEngine';
import type { BpmnDefinitions, SimModel } from '../../src/types/bpmn';

type BpmnModdleInstance = {
  fromXML(xml: string): Promise<{ rootElement: BpmnDefinitions }>;
};

type BpmnModdleCtor = new (extensions?: Record<string, unknown>) => BpmnModdleInstance;

test('embedded subprocess runs as a correlated child case and returns output variables', async () => {
  const model = await loadSubProcessModel();

  makeDeterministic(model);
  const result = new DesEngine(model, simulationOptions()).run();
  const parent = result.cases.find((caseTrace) => caseTrace.trigger === 'arrival');
  const child = result.cases.find((caseTrace) => caseTrace.trigger === 'subProcess');

  assert.equal(model.nodes.get('Event_132c3ou')?.attachedToRefId, 'Activity_0hze3z4');
  assert.equal(model.nodes.get('Event_132c3ou')?.eventDefinitions?.[0]?.name, 'pickerror');
  assert.ok(parent);
  assert.ok(child);
  assert.equal(child.parentCaseId, parent.id);
  assert.equal(child.outputs.parentCaseId, parent.id);
  assert.equal(child.status, 'completed');
  assert.equal(parent.status, 'completed');
  assert.deepEqual(parent.outputs.Activity_1mh7pgf, { priority: 2 });
  assert.equal(executionCount(result, 'EndEvent_Done'), 1);
  assert.equal(executionCount(result, 'Event_1f62628'), 1);
  assert.equal(result.cases.filter((caseTrace) => caseTrace.trigger === 'subProcess').length, 1);
  assert.equal(
    result.timeline.some((event) => {
      return event.processInstanceId === String(child.id) && event.elementId === 'Activity_1mh7pgf';
    }),
    true
  );
});

test('subprocess errors route only through the matching parent Boundary Error Event', async () => {
  const model = await loadSubProcessModel();

  makeDeterministic(model);
  const pickTask = model.nodes.get('Activity_19hm3vv');

  if (!pickTask) {
    throw new Error('Pick task missing');
  }

  pickTask.params.error = {
    probability: 1,
    possibleErrors: [{ errorCode: 'pickerror', probability: 1 }]
  };

  const result = new DesEngine(model, simulationOptions()).run();
  const parent = result.cases.find((caseTrace) => caseTrace.trigger === 'arrival');
  const child = result.cases.find((caseTrace) => caseTrace.trigger === 'subProcess');

  assert.ok(parent);
  assert.ok(child);
  assert.equal(child.status, 'failed');
  assert.equal(child.errors.includes('pickerror'), true);
  assert.equal(parent.status, 'completed');
  assert.equal(executionCount(result, 'Event_132c3ou'), 1);
  assert.equal(executionCount(result, 'Activity_0ekvrt0'), 1);
  assert.equal(executionCount(result, 'Event_0f2w65u'), 0);
  assert.equal(executionCount(result, 'Activity_12capkz'), 0);
  assert.equal(executionCount(result, 'EndEvent_Done'), 0);
  assert.equal(executionCount(result, 'Event_0j8nk05'), 1);
});

async function loadSubProcessModel(): Promise<SimModel> {
  const xml = readFileSync('tests/bpmn/order-fulfillment-with-subprocess.bpmn', 'utf8');
  const { BpmnModdle } = await importBpmnModdle();
  const moddle = new BpmnModdle({ sim: simulationModdle });
  const { rootElement } = await moddle.fromXML(xml);

  return buildBpmnGraph(rootElement);
}

function makeDeterministic(model: SimModel): void {
  const start = model.nodes.get('StartEvent_Order');
  const checkTask = model.nodes.get('Activity_1mh7pgf');
  const pickTask = model.nodes.get('Activity_19hm3vv');
  const shipTask = model.nodes.get('Activity_0a6vs2f');

  if (!start || !checkTask || !pickTask || !shipTask) {
    throw new Error('Subprocess model is incomplete');
  }

  start.params.arrival = { type: 'fixed', interval: 0, numberOfCases: 1 };
  checkTask.params.duration = { type: 'fixed', mean: 1 };
  checkTask.params.outputObject = {
    fields: [{ key: 'priority', type: 'int', generator: 'fixed', value: '2' }]
  };
  checkTask.params.error = { probability: 0 };
  pickTask.params.duration = { type: 'fixed', mean: 1 };
  pickTask.params.error = { probability: 0 };
  shipTask.params.duration = { type: 'fixed', mean: 1 };
  shipTask.params.error = { probability: 0 };

  for (const node of model.nodes.values()) {
    if (node.kind === 'task' || node.kind === 'serviceTask' || node.kind === 'userTask') {
      node.params.duration ??= { type: 'fixed', mean: 1 };
      node.params.error ??= { probability: 0 };
    }
  }

  const inStockFlow = model.flows.get('Flow_0057oy9');
  const backorderFlow = model.flows.get('Flow_031g507');

  if (!inStockFlow || !backorderFlow) {
    throw new Error('Subprocess XOR flows missing');
  }

  inStockFlow.params.branch = { probability: 1 };
  backorderFlow.params.branch = { probability: 0 };
}

function simulationOptions() {
  return {
    numberOfRuns: 1,
    randomSeed: 17,
    animationSpeed: 1,
    collectTraces: true
  };
}

function executionCount(
  result: ReturnType<DesEngine['run']>,
  elementId: string
): number {
  return result.elementMetrics.find((metric) => metric.elementId === elementId)?.visits ?? 0;
}

async function importBpmnModdle(): Promise<{ BpmnModdle: BpmnModdleCtor }> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<{ BpmnModdle: BpmnModdleCtor }>;

  return dynamicImport('bpmn-moddle');
}
